{
  "target_defaults": {
    "defines": [
      "NAPI_VERSION=8"
    ],
    "cflags": [
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror"
    ],
    "xcode_settings": {
      "GCC_C_LANGUAGE_STANDARD": "c11",
      "GCC_TREAT_WARNINGS_AS_ERRORS": "YES"
    },
    "msvs_settings": {
      "VCCLCompilerTool": {
        "AdditionalOptions": [
          "/std:c11"
        ],
        "AdditionalOptions!": [
          "-std:c++20",
          "/std:c++20"
        ]
      }
    }
  },
  "targets": [
    {
      "target_name": "file-lock",
      "sources": [
        "file-lock.c"
      ]
    },
    {
      "target_name": "file-lock-tracked",
      "sources": [
        "../test/fixtures/native-lock-tracked.c"
      ]
    }
  ]
}
