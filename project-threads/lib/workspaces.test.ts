// Run: node --test lib/workspaces.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addProject,
  adoptProjects,
  assignPersonalThread,
  createWorkspace,
  deleteWorkspace,
  initialWorkspacesState,
  moveProject,
  personalThreadWorkspaceId,
  removeProject,
  switchWorkspace,
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

test("each workspace has its own Personal threads; children follow their parent", () => {
  const state = initialWorkspacesState();
  createWorkspace(state, "work", "Work");
  assignPersonalThread(state, "t1", null, true);
  switchWorkspace(state, "default");
  assignPersonalThread(state, "child", "t1", true);
  assignPersonalThread(state, "t2", null, true);
  const where = (id: string) => personalThreadWorkspaceId(state.personalThreadWorkspaceIds, id);
  assert.equal(where("t1"), "work");
  assert.equal(where("child"), "work");
  assert.equal(where("t2"), "default");
  assert.equal(where("older-thread"), "default");
});

test("a top-level Personal thread started with workspaces off goes to Default", () => {
  const state = initialWorkspacesState();
  createWorkspace(state, "work", "Work");
  assignPersonalThread(state, "t1", null, false);
  assert.equal(personalThreadWorkspaceId(state.personalThreadWorkspaceIds, "t1"), "default");
});

test("deleting the active workspace switches to Default; Default can't be deleted", () => {
  const state = initialWorkspacesState();
  createWorkspace(state, "work", "Work");
  assert.equal(deleteWorkspace(state, "default"), false);
  assert.equal(deleteWorkspace(state, "work"), true);
  assert.equal(state.activeId, "default");
});
