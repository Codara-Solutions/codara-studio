const assert = require("node:assert/strict");
const { slugify } = require("../src/slug");

assert.equal(slugify("Hello Spark"), "hello-spark");

