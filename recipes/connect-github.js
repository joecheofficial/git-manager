"use strict";

const { connectGitHub } = require("../github");

module.exports.runRecipe = (input = {}) => connectGitHub(input);
