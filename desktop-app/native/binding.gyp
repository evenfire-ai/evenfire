{
  "targets": [
    {
      "target_name": "evenfire_gfs_save_bridge",
      "conditions": [
        ["OS == 'win'", {
          "sources": ["gfs_save_bridge_win.cc"]
        }, {
          "sources": ["gfs_save_bridge.cc"]
        }]
      ],
      "defines": ["NAPI_VERSION=8", "_WIN32_WINNT=0x0602"],
      "cflags_cc": ["-std=c++17"],
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "CLANG_CXX_LIBRARY": "libc++"
      },
      "msvs_settings": {
        "VCCLCompilerTool": {
          "AdditionalOptions": ["/std:c++17"]
        },
        "VCLinkerTool": {
          "AdditionalDependencies": ["Advapi32.lib"]
        }
      }
    }
  ]
}
