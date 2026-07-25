module.exports = {
  env: {
    es6: true,
    node: true,
  },
  parserOptions: {
    "ecmaVersion": "latest",
  },
  extends: [
    "eslint:recommended",
  ],
  rules: {
    "no-restricted-globals": ["error", "name", "length"],
  },
  overrides: [
    {
      files: ["**/*.spec.*"],
      env: {
        mocha: true,
      },
      rules: {},
    },
  ],
  globals: {},
};
