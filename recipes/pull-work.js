"use strict";

const { pullWork } = require("../github");

module.exports.runRecipe = (input = {}) => pullWork(input);
