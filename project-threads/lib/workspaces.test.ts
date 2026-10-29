// Run: node --test lib/workspaces.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addProject,
  adoptProjects,
  createWorkspace,
  deleteWorkspace,
  initialWorkspacesState,
  moveProject,
  removeProject,
} from "./workspaces.ts";

test("first sync puts every project in Default, Personal first", () => {
  const state = initialWorkspacesState();
  adoptProjects(state, ["a", "personal", "b"], "personal");
  assert.deepEqual(state.workspaces[0].projectIds, ["personal", "a", "b"]);
});

test("a project removed from every workspace isn't re-adopted, a new one goes to the active workspace", () => {
  const state = initialWorkspacesState();
  adoptProjects(state, ["personal", "a"], "personal");
  createWorkspace(state, "work", "Work");
  removeProject(state, "default", "a");
  adoptProjects(state, ["personal", "a", "c"], "personal");
  assert.deepEqual(state.workspaces[0].projectIds, ["personal"]);
  assert.deepEqual(state.workspaces[1].projectIds, ["personal", "c"]);
});

test("a project can be in several workspaces, each with its own order", () => {
  const state = initialWorkspacesState();
  adoptProjects(state, ["a", "b"], null);
  createWorkspace(state, "work", "Work");
  addProject(state, "work", "a");
  addProject(state, "work", "b");
  moveProject(state, "work", "b", "up");
  assert.deepEqual(state.workspaces[0].projectIds, ["a", "b"]);
  assert.deepEqual(state.workspaces[1].projectIds, ["b", "a"]);
  assert.equal(moveProject(state, "work", "b", "up"), false);
});

test("deleting the active workspace switches to Default; Default can't be deleted", () => {
  const state = initialWorkspacesState();
  createWorkspace(state, "work", "Work");
  assert.equal(deleteWorkspace(state, "default"), false);
  assert.equal(deleteWorkspace(state, "work"), true);
  assert.equal(state.activeId, "default");
});
