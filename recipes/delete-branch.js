"use strict";
const { deleteBranch } = require("../branches");
module.exports.runRecipe = (input = {}) => deleteBranch(input.name, { confirm: input.confirm, root: input.repositoryRoot || input.root });
