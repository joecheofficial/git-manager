"use strict";
const runtime = require("../src/index");
module.exports.runRecipe = (input = {}) => runtime.runRecipe("commit", input);
