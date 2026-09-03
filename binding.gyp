{
  "targets": [
    {
      "target_name": "macula_native",
      "sources": ["addon/binding.cc"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "cabi/build"
      ],
      "dependencies": ["<!(node -p \"require('node-addon-api').gyp\")"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "conditions": [
        [
          "OS==\"linux\"",
          {
            "libraries": ["../cabi/build/libmacula.a", "-lpthread"]
          }
        ],
        [
          "OS==\"mac\"",
          {
            "libraries": [
              "../cabi/build/libmacula.a",
              "-framework CoreFoundation",
              "-framework Security"
            ]
          }
        ]
      ]
    }
  ]
}
