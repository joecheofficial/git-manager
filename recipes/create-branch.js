"use strict";
const { createBranch } = require("../branches");
module.exports.runRecipe = (input = {}) => createBranch(input.name, { root: input.repositoryRoot || input.root });
