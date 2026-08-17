"use strict";

const { pushWork } = require("../github");

module.exports.runRecipe = (input = {}) => pushWork(input);
