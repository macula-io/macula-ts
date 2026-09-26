{
  "targets": [
    {
      "target_name": "macula_native",
      "sources": [
        "addon/binding.cc"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "native/build"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS"
      ],
      "conditions": [
        [
          "OS==\"linux\"",
          {
            "libraries": [
              "../native/build/libmacula.a",
              "-lpthread"
            ]
          }
        ],
        [
          "OS==\"mac\"",
          {
            "libraries": [
              "../native/build/libmacula.a",
              "-framework CoreFoundation",
              "-framework Security"
            ]
          }
        ],
        [
          "OS==\"win\"",
          {
            "libraries": [
              "../native/build/macula.lib"
            ],
            "copies": [
              {
                "destination": "<(PRODUCT_DIR)",
                "files": [
                  "native/build/macula.dll"
                ]
              }
            ]
          }
        ]
      ]
    }
  ]
}
