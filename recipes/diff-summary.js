"use strict";
const runtime = require("../src/index");
module.exports.runRecipe = (input = {}) => runtime.runRecipe("diff-stat", input);
