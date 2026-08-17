"use strict";
const { mergeBranch } = require("../branches");
module.exports.runRecipe = (input = {}) => mergeBranch(input.name, { confirm: input.confirm, root: input.repositoryRoot || input.root });
