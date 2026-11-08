#include <node_api.h>

#include <atomic>
#include <cerrno>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fcntl.h>
#include <string>
#include <sys/stat.h>
#include <unistd.h>

#if defined(__APPLE__) || defined(__linux__)
#define EVENFIRE_POSIX 1
#else
#define EVENFIRE_POSIX 0
using dev_t = uint64_t;
using ino_t = uint64_t;
#endif

struct SaveSession {
  int directory_fd = -1;
  int stage_directory_fd = -1;
  int file_fd = -1;
  std::string directory_path;
  std::string target_name;
  std::string stage_directory_name;
  std::string stage_file_name = "content";
  dev_t device = 0;
  ino_t inode = 0;
  bool published = false;
  bool writer_settled = false;
  uint64_t bytes_written = 0;
  bool closed = false;
};

static std::atomic<uint64_t> stage_counter{0};

static void CloseSession(SaveSession* session) {
  if (!session || session->closed) return;
  session->closed = true;
  if (session->file_fd >= 0) close(session->file_fd);
  if (session->stage_directory_fd >= 0) close(session->stage_directory_fd);
  if (session->directory_fd >= 0) close(session->directory_fd);
  session->file_fd = session->stage_directory_fd = session->directory_fd = -1;
}

static void FinalizeSession(napi_env, void* data, void*) {
  SaveSession* session = static_cast<SaveSession*>(data);
  CloseSession(session);
  delete session;
}

static napi_value ThrowErrno(napi_env env, const char* operation) {
  std::string message(operation);
  message += ": ";
  message += strerror(errno);
  napi_throw_error(env, "ERR_GFS_NATIVE", message.c_str());
  return nullptr;
}

static bool GetString(napi_env env, napi_value value, std::string* out) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) return false;
  out->resize(length);
  return napi_get_value_string_utf8(env, value, out->data(), length + 1, &length) == napi_ok;
}

static SaveSession* GetSession(napi_env env, napi_value value) {
  SaveSession* session = nullptr;
  if (napi_get_value_external(env, value, reinterpret_cast<void**>(&session)) != napi_ok ||
      !session || session->closed) {
    napi_throw_error(env, "ERR_GFS_SAVE_SESSION", "invalid or closed GFS save session");
    return nullptr;
  }
  return session;
}

static std::string Identity(const struct stat& info) {
  return std::to_string(static_cast<uint64_t>(info.st_dev)) + ":" +
         std::to_string(static_cast<uint64_t>(info.st_ino));
}

static void CleanupUnpublishedStage(SaveSession* session) {
  if (!session || session->published) return;
  if (session->file_fd >= 0 && session->stage_directory_fd >= 0) {
    struct stat handle_info, entry_info;
    if (fstat(session->file_fd, &handle_info) == 0 &&
        fstatat(session->stage_directory_fd, session->stage_file_name.c_str(), &entry_info,
                AT_SYMLINK_NOFOLLOW) == 0 && S_ISREG(entry_info.st_mode) &&
        handle_info.st_dev == entry_info.st_dev && handle_info.st_ino == entry_info.st_ino) {
      unlinkat(session->stage_directory_fd, session->stage_file_name.c_str(), 0);
    }
  }
  if (session->stage_directory_fd >= 0 && session->directory_fd >= 0 &&
      !session->stage_directory_name.empty()) {
    struct stat handle_info, entry_info;
    if (fstat(session->stage_directory_fd, &handle_info) == 0 &&
        fstatat(session->directory_fd, session->stage_directory_name.c_str(), &entry_info,
                AT_SYMLINK_NOFOLLOW) == 0 && S_ISDIR(entry_info.st_mode) &&
        handle_info.st_dev == entry_info.st_dev && handle_info.st_ino == entry_info.st_ino) {
      unlinkat(session->directory_fd, session->stage_directory_name.c_str(), AT_REMOVEDIR);
    }
  }
}

static napi_value MakeString(napi_env env, const std::string& text) {
  napi_value value;
  napi_create_string_utf8(env, text.c_str(), text.size(), &value);
  return value;
}

static napi_value OpenDestination(napi_env env, napi_callback_info info) {
#if !EVENFIRE_POSIX
  napi_throw_error(env, "ERR_GFS_NATIVE_UNSUPPORTED", "retained POSIX save bridge unavailable");
  return nullptr;
#else
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1) {
    napi_throw_type_error(env, "ERR_GFS_SAVE_PATH", "expected one absolute destination path");
    return nullptr;
  }
  std::string selected_path;
  if (!GetString(env, argv[0], &selected_path) || selected_path.empty() || selected_path[0] != '/') {
    napi_throw_type_error(env, "ERR_GFS_SAVE_PATH", "destination path must be absolute");
    return nullptr;
  }
  size_t slash = selected_path.find_last_of('/');
  std::string directory = slash == 0 ? "/" : selected_path.substr(0, slash);
  std::string target = selected_path.substr(slash + 1);
  if (target.empty() || target == "." || target == ".." || target.find('/') != std::string::npos) {
    napi_throw_type_error(env, "ERR_GFS_SAVE_PATH", "invalid destination basename");
    return nullptr;
  }

  SaveSession* session = new SaveSession();
  session->target_name = target;
  session->directory_path = directory;
  session->directory_fd = open(directory.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (session->directory_fd < 0) {
    delete session;
    return ThrowErrno(env, "open accepted destination directory");
  }
  struct stat directory_info;
  if (fstat(session->directory_fd, &directory_info) != 0 || !S_ISDIR(directory_info.st_mode)) {
    int saved = errno ? errno : ENOTDIR;
    CloseSession(session);
    delete session;
    errno = saved;
    return ThrowErrno(env, "validate accepted destination directory");
  }

  for (int attempt = 0; attempt < 8; ++attempt) {
    uint64_t nonce = stage_counter.fetch_add(1) + 1;
    session->stage_directory_name = ".evenfire-" + std::to_string(static_cast<uint64_t>(getpid())) +
        "-" + std::to_string(nonce) + ".partial";
    if (mkdirat(session->directory_fd, session->stage_directory_name.c_str(), 0700) == 0) break;
    if (errno != EEXIST || attempt == 7) {
      CloseSession(session);
      delete session;
      return ThrowErrno(env, "create private GFS stage directory");
    }
  }
  session->stage_directory_fd = openat(session->directory_fd, session->stage_directory_name.c_str(),
      O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (session->stage_directory_fd < 0) {
    int saved = errno;
    CloseSession(session);
    delete session;
    errno = saved;
    return ThrowErrno(env, "open private GFS stage directory");
  }
  if (fchmod(session->stage_directory_fd, 0700) != 0) {
    int saved = errno;
    CleanupUnpublishedStage(session);
    CloseSession(session);
    delete session;
    errno = saved;
    return ThrowErrno(env, "restrict private GFS stage directory");
  }
  session->file_fd = openat(session->stage_directory_fd, session->stage_file_name.c_str(),
      O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (session->file_fd < 0) {
    int saved = errno;
    CleanupUnpublishedStage(session);
    CloseSession(session);
    delete session;
    errno = saved;
    return ThrowErrno(env, "create private GFS stage file");
  }
  if (fchmod(session->file_fd, 0600) != 0) {
    int saved = errno;
    CleanupUnpublishedStage(session);
    CloseSession(session);
    delete session;
    errno = saved;
    return ThrowErrno(env, "restrict private GFS stage file");
  }
  struct stat file_info;
  if (fstat(session->file_fd, &file_info) != 0 || !S_ISREG(file_info.st_mode) ||
      (file_info.st_mode & 0777) != 0600) {
    int saved = errno ? errno : EACCES;
    CleanupUnpublishedStage(session);
    CloseSession(session);
    delete session;
    errno = saved;
    return ThrowErrno(env, "validate private GFS stage file");
  }
  session->device = file_info.st_dev;
  session->inode = file_info.st_ino;
  napi_value external;
  napi_create_external(env, session, FinalizeSession, nullptr, &external);
  return external;
#endif
}

static napi_value StagePath(napi_env env, napi_callback_info info) {
#if !EVENFIRE_POSIX
  napi_throw_error(env, "ERR_GFS_NATIVE_UNSUPPORTED", "retained POSIX save bridge unavailable");
  return nullptr;
#else
  size_t argc = 1; napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  SaveSession* session = argc == 1 ? GetSession(env, argv[0]) : nullptr;
  if (!session) return nullptr;
  return MakeString(env, session->directory_path + "/" + session->stage_directory_name + "/" +
      session->stage_file_name);
#endif
}

static napi_value StageIdentity(napi_env env, napi_callback_info info) {
#if !EVENFIRE_POSIX
  napi_throw_error(env, "ERR_GFS_NATIVE_UNSUPPORTED", "retained POSIX save bridge unavailable");
  return nullptr;
#else
  size_t argc = 1; napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  SaveSession* session = argc == 1 ? GetSession(env, argv[0]) : nullptr;
  if (!session) return nullptr;
  struct stat file_info;
  if (fstat(session->file_fd, &file_info) != 0) return ThrowErrno(env, "identify retained GFS stage");
  return MakeString(env, Identity(file_info));
#endif
}

static napi_value StageDirectoryPath(napi_env env, napi_callback_info info) {
#if !EVENFIRE_POSIX
  napi_throw_error(env, "ERR_GFS_NATIVE_UNSUPPORTED", "retained POSIX save bridge unavailable");
  return nullptr;
#else
  size_t argc = 1; napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  SaveSession* session = argc == 1 ? GetSession(env, argv[0]) : nullptr;
  if (!session) return nullptr;
  return MakeString(env, session->directory_path + "/" + session->stage_directory_name);
#endif
}

static napi_value StageDirectoryIdentity(napi_env env, napi_callback_info info) {
#if !EVENFIRE_POSIX
  napi_throw_error(env, "ERR_GFS_NATIVE_UNSUPPORTED", "retained POSIX save bridge unavailable");
  return nullptr;
#else
  size_t argc = 1; napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  SaveSession* session = argc == 1 ? GetSession(env, argv[0]) : nullptr;
  if (!session) return nullptr;
  struct stat directory_info;
  if (fstat(session->stage_directory_fd, &directory_info) != 0)
    return ThrowErrno(env, "identify retained GFS stage directory");
  return MakeString(env, Identity(directory_info));
#endif
}

static napi_value WriteChunk(napi_env env, napi_callback_info info) {
#if !EVENFIRE_POSIX
  napi_throw_error(env, "ERR_GFS_NATIVE_UNSUPPORTED", "retained POSIX save bridge unavailable");
  return nullptr;
#else
  size_t argc = 2; napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  SaveSession* session = argc == 2 ? GetSession(env, argv[0]) : nullptr;
  if (!session) return nullptr;
  if (session->writer_settled || session->published) {
    napi_throw_error(env, "ERR_GFS_WRITER_SETTLED", "GFS stage writer is already settled");
    return nullptr;
  }
  void* data = nullptr; size_t length = 0;
  if (napi_get_buffer_info(env, argv[1], &data, &length) != napi_ok) {
    napi_throw_type_error(env, "ERR_GFS_SAVE_BYTES", "expected a Buffer chunk");
    return nullptr;
  }
  size_t offset = 0;
  while (offset < length) {
    ssize_t written = write(session->file_fd, static_cast<char*>(data) + offset, length - offset);
    if (written < 0) { if (errno == EINTR) continue; return ThrowErrno(env, "write private GFS stage"); }
    if (written == 0) { errno = EIO; return ThrowErrno(env, "short write to private GFS stage"); }
    offset += static_cast<size_t>(written);
  }
  session->bytes_written += offset;
  napi_value result; napi_create_uint32(env, static_cast<uint32_t>(offset), &result); return result;
#endif
}

static napi_value SettleWriter(napi_env env, napi_callback_info info) {
#if !EVENFIRE_POSIX
  napi_throw_error(env, "ERR_GFS_NATIVE_UNSUPPORTED", "retained POSIX save bridge unavailable");
  return nullptr;
#else
  size_t argc = 2; napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  SaveSession* session = argc == 2 ? GetSession(env, argv[0]) : nullptr;
  if (!session) return nullptr;
  double expected_number = 0;
  if (napi_get_value_double(env, argv[1], &expected_number) != napi_ok ||
      !std::isfinite(expected_number) || expected_number < 0 ||
      expected_number > static_cast<double>(UINT64_MAX) || std::floor(expected_number) != expected_number) {
    napi_throw_type_error(env, "ERR_GFS_EXPECTED_LENGTH", "expected a byte length");
    return nullptr;
  }
  uint64_t expected_length = static_cast<uint64_t>(expected_number);
  if (session->writer_settled || session->published || session->bytes_written != expected_length) {
    napi_throw_error(env, "ERR_GFS_WRITER_SETTLEMENT", "writer byte count or state is invalid");
    return nullptr;
  }
  if (fsync(session->file_fd) != 0) return ThrowErrno(env, "flush private GFS stage");
  struct stat handle_info, stage_info;
  if (fstat(session->file_fd, &handle_info) != 0 ||
      fstatat(session->stage_directory_fd, session->stage_file_name.c_str(), &stage_info,
              AT_SYMLINK_NOFOLLOW) != 0 ||
      !S_ISREG(stage_info.st_mode) || handle_info.st_dev != stage_info.st_dev ||
      handle_info.st_ino != stage_info.st_ino || handle_info.st_dev != session->device ||
      handle_info.st_ino != session->inode || (stage_info.st_mode & 0777) != 0600) {
    errno = ESTALE; return ThrowErrno(env, "verify settled GFS stage identity");
  }
  session->writer_settled = true;
  napi_value result; napi_get_undefined(env, &result); return result;
#endif
}

static napi_value PublishNoReplace(napi_env env, napi_callback_info info) {
#if !EVENFIRE_POSIX
  napi_throw_error(env, "ERR_GFS_NATIVE_UNSUPPORTED", "retained POSIX save bridge unavailable");
  return nullptr;
#else
  size_t argc = 1; napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  SaveSession* session = argc == 1 ? GetSession(env, argv[0]) : nullptr;
  if (!session) return nullptr;
  if (!session->writer_settled || session->published) { napi_throw_error(env, "ERR_GFS_ALREADY_PUBLISHED", "writer must settle before one-shot publication"); return nullptr; }
  struct stat handle_info, stage_info;
  if (fstat(session->file_fd, &handle_info) != 0 ||
      fstatat(session->stage_directory_fd, session->stage_file_name.c_str(), &stage_info,
              AT_SYMLINK_NOFOLLOW) != 0 || !S_ISREG(stage_info.st_mode) ||
      handle_info.st_dev != stage_info.st_dev || handle_info.st_ino != stage_info.st_ino ||
      handle_info.st_dev != session->device || handle_info.st_ino != session->inode ||
      (stage_info.st_mode & 0777) != 0600) {
    errno = ESTALE; return ThrowErrno(env, "verify private GFS stage before publication");
  }
  if (linkat(session->stage_directory_fd, session->stage_file_name.c_str(),
             session->directory_fd, session->target_name.c_str(), 0) != 0)
    return ThrowErrno(env, "publish GFS file without replacement");
  session->published = true;
  napi_value result; napi_get_boolean(env, true, &result); return result;
#endif
}

static napi_value InspectFinal(napi_env env, napi_callback_info info) {
#if !EVENFIRE_POSIX
  napi_throw_error(env, "ERR_GFS_NATIVE_UNSUPPORTED", "retained POSIX save bridge unavailable");
  return nullptr;
#else
  size_t argc = 1; napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  SaveSession* session = argc == 1 ? GetSession(env, argv[0]) : nullptr;
  if (!session) return nullptr;
  struct stat handle_info, final_info;
  if (fstat(session->file_fd, &handle_info) != 0 ||
      fstatat(session->directory_fd, session->target_name.c_str(), &final_info,
              AT_SYMLINK_NOFOLLOW) != 0) return ThrowErrno(env, "read published GFS identity");
  if (!S_ISREG(final_info.st_mode) || handle_info.st_dev != final_info.st_dev ||
      handle_info.st_ino != final_info.st_ino || handle_info.st_dev != session->device ||
      handle_info.st_ino != session->inode) {
    napi_throw_error(env, "ESTALE", "published GFS identity differs from retained file handle");
    return nullptr;
  }
  return MakeString(env, Identity(final_info));
#endif
}

static napi_value IsPublished(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  SaveSession* session = argc == 1 ? GetSession(env, argv[0]) : nullptr;
  if (!session) return nullptr;
  napi_value result; napi_get_boolean(env, session->published, &result); return result;
}

static napi_value ApplyFinalMode(napi_env env, napi_callback_info info) {
#if !EVENFIRE_POSIX
  napi_throw_error(env, "ERR_GFS_NATIVE_UNSUPPORTED", "retained POSIX save bridge unavailable");
  return nullptr;
#else
  size_t argc = 2; napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  SaveSession* session = argc == 2 ? GetSession(env, argv[0]) : nullptr;
  if (!session) return nullptr;
  uint32_t mode = 0;
  napi_get_value_uint32(env, argv[1], &mode);
  if (!session->published || (mode & ~0777u) != 0) {
    napi_throw_error(env, "ERR_GFS_FINAL_MODE", "invalid final mode state"); return nullptr;
  }
  if (fchmod(session->file_fd, static_cast<mode_t>(mode)) != 0)
    return ThrowErrno(env, "apply final GFS mode through retained file handle");
  struct stat final_info;
  if (fstat(session->file_fd, &final_info) != 0 || (final_info.st_mode & 0777) != mode) {
    errno = EIO; return ThrowErrno(env, "verify final GFS mode through retained file handle");
  }
  napi_value result; napi_create_uint32(env, final_info.st_mode & 0777, &result); return result;
#endif
}

static napi_value InspectFinalMode(napi_env env, napi_callback_info info) {
#if !EVENFIRE_POSIX
  napi_throw_error(env, "ERR_GFS_NATIVE_UNSUPPORTED", "retained POSIX save bridge unavailable");
  return nullptr;
#else
  size_t argc = 1; napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  SaveSession* session = argc == 1 ? GetSession(env, argv[0]) : nullptr;
  if (!session) return nullptr;
  struct stat file_info;
  if (fstat(session->file_fd, &file_info) != 0) return ThrowErrno(env, "read final GFS permissions");
  if (file_info.st_dev != session->device || file_info.st_ino != session->inode) {
    napi_throw_error(env, "ESTALE", "retained GFS file identity changed");
    return nullptr;
  }
  napi_value result; napi_create_uint32(env, file_info.st_mode & 0777, &result); return result;
#endif
}

static napi_value CleanupStage(napi_env env, napi_callback_info info) {
#if !EVENFIRE_POSIX
  napi_throw_error(env, "ERR_GFS_NATIVE_UNSUPPORTED", "retained POSIX save bridge unavailable");
  return nullptr;
#else
  size_t argc = 1; napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  SaveSession* session = argc == 1 ? GetSession(env, argv[0]) : nullptr;
  if (!session) return nullptr;
  struct stat handle_info, stage_info;
  if (fstat(session->file_fd, &handle_info) != 0) return ThrowErrno(env, "identify retained GFS stage");
  if (fstatat(session->stage_directory_fd, session->stage_file_name.c_str(), &stage_info,
              AT_SYMLINK_NOFOLLOW) == 0) {
    if (!S_ISREG(stage_info.st_mode) || stage_info.st_dev != handle_info.st_dev ||
        stage_info.st_ino != handle_info.st_ino) {
      errno = ESTALE; return ThrowErrno(env, "refuse cleanup of replaced GFS stage alias");
    }
    if (unlinkat(session->stage_directory_fd, session->stage_file_name.c_str(), 0) != 0)
      return ThrowErrno(env, "remove exact GFS stage alias");
  } else if (errno != ENOENT) return ThrowErrno(env, "inspect GFS stage alias");
  struct stat dir_handle, dir_entry;
  if (fstat(session->stage_directory_fd, &dir_handle) != 0) return ThrowErrno(env, "identify GFS stage directory");
  if (fstatat(session->directory_fd, session->stage_directory_name.c_str(), &dir_entry,
              AT_SYMLINK_NOFOLLOW) == 0) {
    if (!S_ISDIR(dir_entry.st_mode) || dir_entry.st_dev != dir_handle.st_dev ||
        dir_entry.st_ino != dir_handle.st_ino) {
      errno = ESTALE; return ThrowErrno(env, "refuse cleanup of replaced GFS stage directory");
    }
    if (unlinkat(session->directory_fd, session->stage_directory_name.c_str(), AT_REMOVEDIR) != 0)
      return ThrowErrno(env, "remove exact GFS stage directory");
  } else if (errno != ENOENT) return ThrowErrno(env, "inspect GFS stage directory");
  napi_value result; napi_get_undefined(env, &result); return result;
#endif
}

static napi_value RemovePublishedStageAlias(napi_env env, napi_callback_info info) {
#if !EVENFIRE_POSIX
  napi_throw_error(env, "ERR_GFS_NATIVE_UNSUPPORTED", "retained POSIX save bridge unavailable");
  return nullptr;
#else
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  SaveSession* session = argc == 1 ? GetSession(env, argv[0]) : nullptr;
  if (!session) return nullptr;
  if (!session->published || !session->writer_settled) {
    napi_throw_error(env, "ERR_GFS_STAGE_ALIAS_STATE",
                     "published stage alias cleanup requires settled publication");
    return nullptr;
  }
  struct stat handle_info, stage_info;
  if (fstat(session->file_fd, &handle_info) != 0)
    return ThrowErrno(env, "identify published GFS file before stage alias cleanup");
  if (fstatat(session->stage_directory_fd, session->stage_file_name.c_str(), &stage_info,
              AT_SYMLINK_NOFOLLOW) == 0) {
    if (!S_ISREG(stage_info.st_mode) || stage_info.st_dev != handle_info.st_dev ||
        stage_info.st_ino != handle_info.st_ino || handle_info.st_dev != session->device ||
        handle_info.st_ino != session->inode) {
      errno = ESTALE;
      return ThrowErrno(env, "refuse cleanup of replaced published GFS stage alias");
    }
    if (unlinkat(session->stage_directory_fd, session->stage_file_name.c_str(), 0) != 0)
      return ThrowErrno(env, "remove exact published GFS stage alias");
  } else if (errno != ENOENT) {
    return ThrowErrno(env, "inspect published GFS stage alias");
  }
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
#endif
}

static napi_value CloseNativeSession(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  SaveSession* session = nullptr;
  if (argc != 1 || napi_get_value_external(env, argv[0], reinterpret_cast<void**>(&session)) != napi_ok ||
      !session) {
    napi_throw_type_error(env, "ERR_GFS_SAVE_SESSION", "invalid GFS save session");
    return nullptr;
  }
  CloseSession(session);
  napi_value result; napi_get_undefined(env, &result); return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"openDestination", nullptr, OpenDestination, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"stagePath", nullptr, StagePath, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"stageIdentity", nullptr, StageIdentity, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"stageDirectoryPath", nullptr, StageDirectoryPath, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"stageDirectoryIdentity", nullptr, StageDirectoryIdentity, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"writeChunk", nullptr, WriteChunk, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"settleWriter", nullptr, SettleWriter, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"publishNoReplace", nullptr, PublishNoReplace, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"isPublished", nullptr, IsPublished, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"inspectFinal", nullptr, InspectFinal, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"applyFinalMode", nullptr, ApplyFinalMode, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"inspectFinalMode", nullptr, InspectFinalMode, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"cleanupStage", nullptr, CleanupStage, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"removePublishedStageAlias", nullptr, RemovePublishedStageAlias, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"closeSession", nullptr, CloseNativeSession, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
