#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <node_api.h>

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

namespace {

struct SaveSession {
  HANDLE directory = INVALID_HANDLE_VALUE;
  HANDLE published_file = INVALID_HANDLE_VALUE;  // Hpub; retained across rename/finalization.
  HANDLE writer = INVALID_HANDLE_VALUE;          // Hwrite; closed before publication.
  PSECURITY_DESCRIPTOR intended_sd = nullptr;
  std::wstring directory_path;
  std::wstring target_name;
  std::wstring stage_path;
  std::string identity;
  std::string private_sddl;
  std::string intended_sddl;
  uint64_t bytes_written = 0;
  bool writer_settled = false;
  bool published = false;
  bool closed = false;
};

std::atomic<uint64_t> g_stage_counter{0};

std::string WinMessage(const char* operation, DWORD error = GetLastError()) {
  char buffer[256]{};
  std::snprintf(buffer, sizeof(buffer), "%s failed (Win32 error %lu)", operation,
                static_cast<unsigned long>(error));
  return buffer;
}

napi_value ThrowWin(napi_env env, const char* operation, DWORD error = GetLastError()) {
  const auto message = WinMessage(operation, error);
  napi_throw_error(env, "ERR_GFS_NATIVE", message.c_str());
  return nullptr;
}

napi_value ThrowState(napi_env env, const char* code, const char* message) {
  napi_throw_error(env, code, message);
  return nullptr;
}

bool GetUtf8(napi_env env, napi_value value, std::string* out) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) return false;
  std::vector<char> bytes(length + 1, '\0');
  if (napi_get_value_string_utf8(env, value, bytes.data(), bytes.size(), &length) != napi_ok)
    return false;
  out->assign(bytes.data(), length);
  return true;
}

bool GetWide(napi_env env, napi_value value, std::wstring* out) {
  std::string utf8;
  if (!GetUtf8(env, value, &utf8) || utf8.empty()) return false;
  const int needed = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8.c_str(), -1,
                                          nullptr, 0);
  if (needed <= 1) return false;
  std::vector<wchar_t> wide(static_cast<size_t>(needed));
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8.c_str(), -1,
                          wide.data(), needed) != needed) return false;
  out->assign(wide.data());
  return true;
}

napi_value MakeString(napi_env env, const std::string& value) {
  napi_value result;
  napi_create_string_utf8(env, value.c_str(), value.size(), &result);
  return result;
}

napi_value MakeWideString(napi_env env, const std::wstring& value) {
  const int needed = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.c_str(), -1,
                                          nullptr, 0, nullptr, nullptr);
  if (needed <= 1) return ThrowWin(env, "encode native GFS path", GetLastError());
  std::vector<char> utf8(static_cast<size_t>(needed));
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.c_str(), -1,
                          utf8.data(), needed, nullptr, nullptr) != needed)
    return ThrowWin(env, "encode native GFS path", GetLastError());
  return MakeString(env, std::string(utf8.data()));
}

bool SameHandle(HANDLE left, HANDLE right) {
  FILE_ID_INFO a{}, b{};
  if (!GetFileInformationByHandleEx(left, FileIdInfo, &a, sizeof(a)) ||
      !GetFileInformationByHandleEx(right, FileIdInfo, &b, sizeof(b))) return false;
  return a.VolumeSerialNumber == b.VolumeSerialNumber &&
      std::memcmp(a.FileId.Identifier, b.FileId.Identifier, sizeof(a.FileId.Identifier)) == 0;
}

std::string FileIdentity(HANDLE handle) {
  FILE_ID_INFO info{};
  if (!GetFileInformationByHandleEx(handle, FileIdInfo, &info, sizeof(info)))
    return {};
  char text[8 + 1 + 32 + 1]{};
  std::snprintf(text, sizeof(text), "%016llX:",
      static_cast<unsigned long long>(info.VolumeSerialNumber));
  size_t offset = std::strlen(text);
  for (size_t i = 0; i < sizeof(info.FileId.Identifier); ++i) {
    std::snprintf(text + offset, sizeof(text) - offset, "%02X",
                  static_cast<unsigned char>(info.FileId.Identifier[i]));
    offset += 2;
  }
  return text;
}

std::string WideToUtf8(const std::wstring& value) {
  const int needed = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.c_str(), -1,
                                          nullptr, 0, nullptr, nullptr);
  if (needed <= 1) return {};
  std::vector<char> result(static_cast<size_t>(needed));
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.c_str(), -1,
                          result.data(), needed, nullptr, nullptr) != needed) return {};
  return std::string(result.data());
}

std::string DescriptorSddl(PSECURITY_DESCRIPTOR descriptor) {
  LPWSTR sddl = nullptr;
  ULONG length = 0;
  if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(
          descriptor, SDDL_REVISION_1, DACL_SECURITY_INFORMATION, &sddl, &length)) return {};
  std::wstring wide(sddl);
  LocalFree(sddl);
  return WideToUtf8(wide);
}

void CloseSession(SaveSession* session, bool cleanup_private_stage) {
  if (!session || session->closed) return;
  session->closed = true;
  if (cleanup_private_stage && !session->published &&
      session->published_file != INVALID_HANDLE_VALUE) {
    FILE_DISPOSITION_INFO disposition{};
    disposition.DeleteFile = TRUE;
    SetFileInformationByHandle(session->published_file, FileDispositionInfo,
                               &disposition, sizeof(disposition));
  }
  if (session->writer != INVALID_HANDLE_VALUE) CloseHandle(session->writer);
  if (session->published_file != INVALID_HANDLE_VALUE) CloseHandle(session->published_file);
  if (session->directory != INVALID_HANDLE_VALUE) CloseHandle(session->directory);
  if (session->intended_sd) DestroyPrivateObjectSecurity(&session->intended_sd);
  session->writer = session->published_file = session->directory = INVALID_HANDLE_VALUE;
}

void FinalizeSession(napi_env, void* data, void*) {
  auto* session = static_cast<SaveSession*>(data);
  CloseSession(session, true);
  delete session;
}

SaveSession* GetSession(napi_env env, napi_value value) {
  SaveSession* session = nullptr;
  if (napi_get_value_external(env, value, reinterpret_cast<void**>(&session)) != napi_ok ||
      !session || session->closed) {
    napi_throw_error(env, "ERR_GFS_SAVE_SESSION", "invalid or closed GFS save session");
    return nullptr;
  }
  return session;
}

bool MakeCurrentSid(std::wstring* sid_text, PSID* sid_copy) {
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
  DWORD needed = 0;
  GetTokenInformation(token, TokenUser, nullptr, 0, &needed);
  std::vector<uint8_t> token_info(needed);
  const bool got = needed && GetTokenInformation(token, TokenUser, token_info.data(), needed,
                                                   &needed);
  CloseHandle(token);
  if (!got) return false;
  auto* user = reinterpret_cast<TOKEN_USER*>(token_info.data());
  LPWSTR converted = nullptr;
  if (!ConvertSidToStringSidW(user->User.Sid, &converted)) return false;
  *sid_text = converted;
  LocalFree(converted);
  const DWORD sid_size = GetLengthSid(user->User.Sid);
  *sid_copy = LocalAlloc(LMEM_FIXED, sid_size);
  return *sid_copy && CopySid(sid_size, *sid_copy, user->User.Sid);
}

bool CreatePrivateDescriptor(PSECURITY_DESCRIPTOR* descriptor, std::wstring* owner_sid) {
  PSID sid = nullptr;
  if (!MakeCurrentSid(owner_sid, &sid)) return false;
  std::wstring sddl = L"D:P(A;;FA;;;" + *owner_sid + L")(A;;FA;;;SY)";
  const BOOL result = ConvertStringSecurityDescriptorToSecurityDescriptorW(
      sddl.c_str(), SDDL_REVISION_1, descriptor, nullptr);
  LocalFree(sid);
  return result == TRUE;
}

bool CreateIntendedDescriptor(HANDLE directory, PSECURITY_DESCRIPTOR* descriptor) {
  PSID owner = nullptr;
  HANDLE token = nullptr;
  PSECURITY_DESCRIPTOR parent = nullptr;
  bool ok = false;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
  const DWORD status = GetSecurityInfo(directory, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                                       nullptr, nullptr, nullptr, nullptr, &parent);
  if (status == ERROR_SUCCESS) {
    GENERIC_MAPPING mapping{};
    mapping.GenericRead = FILE_GENERIC_READ;
    mapping.GenericWrite = FILE_GENERIC_WRITE;
    mapping.GenericExecute = FILE_GENERIC_EXECUTE;
    mapping.GenericAll = FILE_ALL_ACCESS;
    ok = CreatePrivateObjectSecurityEx(parent, nullptr, descriptor, nullptr, FALSE,
          SEF_DACL_AUTO_INHERIT | SEF_DEFAULT_GROUP_FROM_PARENT, token, &mapping) == TRUE;
  }
  if (parent) LocalFree(parent);
  CloseHandle(token);
  return ok;
}

bool GetDacl(HANDLE handle, PACL* dacl, PSECURITY_DESCRIPTOR* descriptor) {
  const DWORD status = GetSecurityInfo(handle, SE_FILE_OBJECT,
      OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      nullptr, nullptr, dacl, nullptr, descriptor);
  return status == ERROR_SUCCESS;
}

bool DaclMatches(HANDLE handle, const std::string& expected) {
  PACL dacl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  if (!GetDacl(handle, &dacl, &descriptor)) return false;
  const std::string actual = DescriptorSddl(descriptor);
  LocalFree(descriptor);
  return !actual.empty() && actual == expected;
}

bool ParentIsSupported(HANDLE directory, std::string* filesystem) {
  FILE_ATTRIBUTE_TAG_INFO attributes{};
  if (!GetFileInformationByHandleEx(directory, FileAttributeTagInfo,
                                    &attributes, sizeof(attributes))) return false;
  if ((attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
      (attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) return false;
  wchar_t fs_name[MAX_PATH + 1]{};
  if (!GetVolumeInformationByHandleW(directory, nullptr, 0, nullptr, nullptr, nullptr,
                                     fs_name, MAX_PATH + 1)) return false;
  *filesystem = WideToUtf8(fs_name);
  return *filesystem == "NTFS" || *filesystem == "ReFS";
}

bool ParseTarget(const std::wstring& selected, std::wstring* directory,
                 std::wstring* target) {
  if (selected.size() < 4 || selected.find(L'\0') != std::wstring::npos) return false;
  // Reject relative, device-namespace and alternate-stream selections. Save dialogs
  // provide ordinary absolute drive/UNC paths; native publication needs one basename.
  if (!(selected.size() >= 3 && selected[1] == L':' &&
        (selected[2] == L'\\' || selected[2] == L'/')) &&
      !(selected.size() >= 3 && selected[0] == L'\\' && selected[1] == L'\\' &&
        selected[2] != L'?' && selected[2] != L'.')) return false;
  const size_t slash = selected.find_last_of(L"\\/");
  if (slash == std::wstring::npos || slash + 1 >= selected.size()) return false;
  *directory = slash == 2 && selected[1] == L':' ? selected.substr(0, 3) : selected.substr(0, slash);
  *target = selected.substr(slash + 1);
  if (target->empty() || *target == L"." || *target == L".." ||
      target->back() == L'.' || target->back() == L' ' ||
      target->find_first_of(L"<>:\"/\\|?*") != std::wstring::npos) return false;
  return true;
}

napi_value OpenDestination(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  std::wstring selected, directory, target;
  if (argc != 1 || !GetWide(env, argv[0], &selected) ||
      !ParseTarget(selected, &directory, &target))
    return ThrowState(env, "ERR_GFS_SAVE_PATH", "expected a safe absolute Windows destination path");

  auto* session = new SaveSession();
  session->directory_path = directory;
  session->target_name = target;
  session->directory = CreateFileW(directory.c_str(),
      FILE_LIST_DIRECTORY | FILE_ADD_FILE | FILE_READ_ATTRIBUTES | READ_CONTROL,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (session->directory == INVALID_HANDLE_VALUE) {
    const DWORD error = GetLastError(); delete session;
    return ThrowWin(env, "open accepted destination directory", error);
  }
  std::string filesystem;
  if (!ParentIsSupported(session->directory, &filesystem) ||
      !CreateIntendedDescriptor(session->directory, &session->intended_sd)) {
    CloseSession(session, false); delete session;
    return ThrowState(env, "ERR_GFS_NATIVE_UNSUPPORTED",
                      "destination must be a validated NTFS or ReFS directory with readable ACLs");
  }
  session->intended_sddl = DescriptorSddl(session->intended_sd);
  if (session->intended_sddl.empty()) {
    CloseSession(session, false); delete session;
    return ThrowWin(env, "capture intended child access descriptor");
  }

  std::wstring owner_sid;
  PSECURITY_DESCRIPTOR private_sd = nullptr;
  if (!CreatePrivateDescriptor(&private_sd, &owner_sid)) {
    CloseSession(session, false); delete session;
    return ThrowWin(env, "create private stage access descriptor");
  }
  session->private_sddl = DescriptorSddl(private_sd);
  SECURITY_ATTRIBUTES security{};
  security.nLength = sizeof(security);
  security.lpSecurityDescriptor = private_sd;
  const wchar_t separator = directory.back() == L'\\' || directory.back() == L'/' ? L'\0' : L'\\';
  bool created = false;
  DWORD create_error = ERROR_FILE_EXISTS;
  for (int attempt = 0; attempt < 16; ++attempt) {
    const auto nonce = g_stage_counter.fetch_add(1) + 1;
    session->stage_path = directory + (separator ? std::wstring(1, separator) : L"") +
        L".evenfire-" + std::to_wstring(GetCurrentProcessId()) + L"-" +
        std::to_wstring(nonce) + L".partial";
    session->published_file = CreateFileW(session->stage_path.c_str(),
        DELETE | READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES,
        FILE_SHARE_WRITE, &security, CREATE_NEW, FILE_ATTRIBUTE_NORMAL |
        FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (session->published_file != INVALID_HANDLE_VALUE) { created = true; break; }
    create_error = GetLastError();
    if (create_error != ERROR_FILE_EXISTS && create_error != ERROR_ALREADY_EXISTS) break;
  }
  LocalFree(private_sd);
  if (!created) {
    CloseSession(session, false); delete session;
    return ThrowWin(env, "create private GFS stage with CREATE_NEW", create_error);
  }
  if (session->private_sddl.empty() || !DaclMatches(session->published_file, session->private_sddl)) {
    CloseSession(session, true); delete session;
    return ThrowState(env, "ERR_GFS_STAGE_ACL", "new stage does not have the exact protected private DACL");
  }
  session->identity = FileIdentity(session->published_file);
  if (session->identity.empty()) {
    CloseSession(session, true); delete session;
    return ThrowWin(env, "identify private GFS stage");
  }
  session->writer = CreateFileW(session->stage_path.c_str(), GENERIC_WRITE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (session->writer == INVALID_HANDLE_VALUE || !SameHandle(session->published_file, session->writer)) {
    const DWORD error = session->writer == INVALID_HANDLE_VALUE ? GetLastError() : ERROR_FILE_INVALID;
    CloseSession(session, true); delete session;
    return ThrowWin(env, "open and bind trusted GFS writer handle", error);
  }
  napi_value external;
  napi_create_external(env, session, FinalizeSession, nullptr, &external);
  return external;
}

napi_value StagePath(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1]; napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  auto* session = argc == 1 ? GetSession(env, argv[0]) : nullptr;
  return session ? MakeWideString(env, session->stage_path) : nullptr;
}

napi_value StageIdentity(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1]; napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  auto* session = argc == 1 ? GetSession(env, argv[0]) : nullptr;
  return session ? MakeString(env, session->identity) : nullptr;
}

napi_value StageObservation(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1]; napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  auto* session = argc == 1 ? GetSession(env, argv[0]) : nullptr;
  if (!session) return nullptr;
  std::wstring owner_sid; PSID sid = nullptr;
  if (!MakeCurrentSid(&owner_sid, &sid)) return ThrowWin(env, "read current owner SID");
  LocalFree(sid);
  FILE_STANDARD_INFO standard{};
  if (!GetFileInformationByHandleEx(session->published_file, FileStandardInfo,
                                    &standard, sizeof(standard)))
    return ThrowWin(env, "inspect private stage length");
  napi_value result, value;
  napi_create_object(env, &result);
  napi_create_string_utf8(env, WideToUtf8(owner_sid).c_str(), NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, result, "ownerSid", value);
  napi_create_string_utf8(env, session->private_sddl.c_str(), NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, result, "daclSddl", value);
  napi_get_boolean(env, true, &value); napi_set_named_property(env, result, "daclProtected", value);
  napi_create_double(env, static_cast<double>(standard.EndOfFile.QuadPart), &value);
  napi_set_named_property(env, result, "length", value);
  napi_get_boolean(env, false, &value); napi_set_named_property(env, result, "hidden", value);
  napi_create_string_utf8(env, session->identity.c_str(), NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, result, "identity", value);
  return result;
}

napi_value WriteChunk(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value argv[2]; napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  auto* session = argc == 2 ? GetSession(env, argv[0]) : nullptr;
  if (!session) return nullptr;
  if (session->writer_settled || session->published || session->writer == INVALID_HANDLE_VALUE)
    return ThrowState(env, "ERR_GFS_WRITER_SETTLED", "GFS stage writer is already settled");
  void* data = nullptr; size_t length = 0;
  if (napi_get_buffer_info(env, argv[1], &data, &length) != napi_ok)
    return ThrowState(env, "ERR_GFS_SAVE_BYTES", "expected a Buffer chunk");
  size_t offset = 0;
  while (offset < length) {
    const DWORD amount = static_cast<DWORD>(std::min<size_t>(length - offset, MAXDWORD));
    DWORD written = 0;
    if (!WriteFile(session->writer, static_cast<char*>(data) + offset, amount, &written, nullptr))
      return ThrowWin(env, "write private GFS stage");
    if (written == 0) return ThrowWin(env, "write private GFS stage", ERROR_WRITE_FAULT);
    offset += written;
  }
  session->bytes_written += offset;
  napi_value result; napi_create_double(env, static_cast<double>(offset), &result); return result;
}

napi_value SettleWriter(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value argv[2]; napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  auto* session = argc == 2 ? GetSession(env, argv[0]) : nullptr;
  if (!session) return nullptr;
  double expected = 0;
  if (napi_get_value_double(env, argv[1], &expected) != napi_ok || expected < 0 ||
      expected != static_cast<double>(session->bytes_written) || session->writer_settled)
    return ThrowState(env, "ERR_GFS_WRITER_SETTLEMENT", "writer count or state is invalid");
  if (!FlushFileBuffers(session->writer)) return ThrowWin(env, "flush private GFS stage");
  FILE_STANDARD_INFO standard{};
  if (!GetFileInformationByHandleEx(session->writer, FileStandardInfo, &standard, sizeof(standard)) ||
      standard.EndOfFile.QuadPart != static_cast<LONGLONG>(session->bytes_written) ||
      !SameHandle(session->writer, session->published_file) ||
      FileIdentity(session->published_file) != session->identity ||
      !DaclMatches(session->published_file, session->private_sddl))
    return ThrowState(env, "ERR_GFS_WRITER_SETTLEMENT", "settled stage identity, length, or DACL changed");
  CloseHandle(session->writer);
  session->writer = INVALID_HANDLE_VALUE;
  session->writer_settled = true;
  napi_value result; napi_get_undefined(env, &result); return result;
}

napi_value PublishNoReplace(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1]; napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  auto* session = argc == 1 ? GetSession(env, argv[0]) : nullptr;
  if (!session) return nullptr;
  if (!session->writer_settled || session->published || session->writer != INVALID_HANDLE_VALUE)
    return ThrowState(env, "ERR_GFS_ALREADY_PUBLISHED", "writer must settle before one-shot publication");
  if (FileIdentity(session->published_file) != session->identity ||
      !DaclMatches(session->published_file, session->private_sddl))
    return ThrowState(env, "ERR_GFS_STAGE_IDENTITY", "private stage identity or DACL changed");
  FILE_ID_INFO file_id{}, directory_id{};
  if (!GetFileInformationByHandleEx(session->published_file, FileIdInfo, &file_id, sizeof(file_id)) ||
      !GetFileInformationByHandleEx(session->directory, FileIdInfo, &directory_id, sizeof(directory_id)))
    return ThrowWin(env, "read retained destination volume identity");
  if (file_id.VolumeSerialNumber != directory_id.VolumeSerialNumber)
    return ThrowState(env, "ERR_GFS_CROSS_VOLUME", "stage and accepted destination are on different volumes");
  const auto name_bytes = session->target_name.size() * sizeof(wchar_t);
  const size_t total = offsetof(FILE_RENAME_INFO, FileName) + name_bytes;
  std::vector<uint8_t> storage(total, 0);
  auto* rename = reinterpret_cast<FILE_RENAME_INFO*>(storage.data());
  rename->ReplaceIfExists = FALSE;
  rename->RootDirectory = session->directory;
  rename->FileNameLength = static_cast<DWORD>(name_bytes);
  std::memcpy(rename->FileName, session->target_name.data(), name_bytes);
  if (!SetFileInformationByHandle(session->published_file, FileRenameInfo, rename,
                                  static_cast<DWORD>(total)))
    return ThrowWin(env, "publish GFS file relative to retained destination handle");
  // Irreversible native-effect latch: no fallible work may precede this assignment.
  session->published = true;
  napi_value result; napi_get_boolean(env, true, &result); return result;
}

napi_value InspectFinal(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1]; napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  auto* session = argc == 1 ? GetSession(env, argv[0]) : nullptr;
  if (!session) return nullptr;
  if (!session->published || FileIdentity(session->published_file) != session->identity)
    return ThrowState(env, "ERR_GFS_FINAL_IDENTITY", "published handle identity is not verified");
  return MakeString(env, session->identity);
}

napi_value IsPublished(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1]; napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  auto* session = argc == 1 ? GetSession(env, argv[0]) : nullptr;
  if (!session) return nullptr;
  napi_value result; napi_get_boolean(env, session->published, &result); return result;
}

napi_value ApplyFinalAccess(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1]; napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  auto* session = argc == 1 ? GetSession(env, argv[0]) : nullptr;
  if (!session) return nullptr;
  if (!session->published) return ThrowState(env, "ERR_GFS_FINAL_ACL", "file is not published");
  PACL dacl = nullptr;
  BOOL present = FALSE, defaulted = FALSE;
  if (!GetSecurityDescriptorDacl(session->intended_sd, &present, &dacl, &defaulted) || !present)
    return ThrowState(env, "ERR_GFS_FINAL_ACL", "intended destination DACL is unavailable");
  const DWORD status = SetSecurityInfo(session->published_file, SE_FILE_OBJECT,
      DACL_SECURITY_INFORMATION | UNPROTECTED_DACL_SECURITY_INFORMATION,
      nullptr, nullptr, dacl, nullptr);
  if (status != ERROR_SUCCESS) return ThrowWin(env, "apply inherited destination DACL", status);
  napi_value result; napi_get_undefined(env, &result); return result;
}

napi_value InspectFinalAccess(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1]; napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  auto* session = argc == 1 ? GetSession(env, argv[0]) : nullptr;
  if (!session) return nullptr;
  if (!session->published) return ThrowState(env, "ERR_GFS_FINAL_ACL", "file is not published");
  if (DaclMatches(session->published_file, session->intended_sddl))
    return MakeString(env, "intended");
  if (DaclMatches(session->published_file, session->private_sddl))
    return MakeString(env, "private");
  return MakeString(env, "unknown");
}

napi_value CleanupStage(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1]; napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  auto* session = argc == 1 ? GetSession(env, argv[0]) : nullptr;
  if (!session) return nullptr;
  if (!session->published) {
    if (!session->writer_settled || session->writer != INVALID_HANDLE_VALUE)
      return ThrowState(env, "ERR_GFS_WRITER_ACTIVE", "cannot clean a stage while a writer is active");
    FILE_DISPOSITION_INFO disposition{}; disposition.DeleteFile = TRUE;
    if (!SetFileInformationByHandle(session->published_file, FileDispositionInfo,
                                    &disposition, sizeof(disposition)))
      return ThrowWin(env, "delete exact private GFS stage handle");
  }
  napi_value result; napi_get_undefined(env, &result); return result;
}

napi_value CloseSessionNative(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1]; napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  SaveSession* session = nullptr;
  if (argc != 1 || napi_get_value_external(env, argv[0], reinterpret_cast<void**>(&session)) != napi_ok || !session)
    return ThrowState(env, "ERR_GFS_SAVE_SESSION", "invalid GFS save session");
  CloseSession(session, true);
  napi_value result; napi_get_undefined(env, &result); return result;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"openDestination", nullptr, OpenDestination, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"stagePath", nullptr, StagePath, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"stageIdentity", nullptr, StageIdentity, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"stageObservation", nullptr, StageObservation, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"writeChunk", nullptr, WriteChunk, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"settleWriter", nullptr, SettleWriter, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"publishNoReplace", nullptr, PublishNoReplace, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"isPublished", nullptr, IsPublished, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"inspectFinal", nullptr, InspectFinal, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"applyFinalAccess", nullptr, ApplyFinalAccess, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"inspectFinalAccess", nullptr, InspectFinalAccess, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"cleanupStage", nullptr, CleanupStage, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"closeSession", nullptr, CloseSessionNative, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
