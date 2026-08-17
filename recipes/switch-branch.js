"use strict";
const { switchBranch } = require("../branches");
module.exports.runRecipe = (input = {}) => switchBranch(input.name, { root: input.repositoryRoot || input.root });
