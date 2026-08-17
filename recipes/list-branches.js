"use strict";
const { listBranches } = require("../branches");
module.exports.runRecipe = (input = {}) => listBranches({ includeRemote: input.includeRemote !== false, root: input.repositoryRoot || input.root });
