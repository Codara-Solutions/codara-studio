// groupForAgents (lib/policy.js): the tab an agent opened joins or makes its
// group, and a link that closed meanwhile leaves no grouping behind, whether
// naming the group worked or not.

import assert from "node:assert/strict";

import { groupForAgents } from "../lib/policy.js";

/** chrome.tabs and chrome.tabGroups for one window, with a hook on update. */
function fakeChrome({ groups = [], onUpdate = async () => {} } = {}) {
  const tab = { id: 7, windowId: 1, groupId: -1 };
  let nextGroup = 100;
  const tabs = {
    get: async (id) => (id === tab.id ? { ...tab } : null),
    group: async ({ groupId, tabIds, createProperties }) => {
      assert.deepEqual(tabIds, [tab.id]);
      if (groupId === undefined) {
        assert.equal(createProperties.windowId, tab.windowId);
        groupId = nextGroup++;
        groups.push({ id: groupId, title: "" });
      }
      tab.groupId = groupId;
      return groupId;
    },
    ungroup: async (id) => {
      assert.equal(id, tab.id);
      tab.groupId = -1;
    },
  };
  const tabGroups = {
    query: async ({ windowId }) => (windowId === tab.windowId ? groups.map((group) => ({ ...group })) : []),
    update: async (groupId, { title }) => {
      await onUpdate(groupId);
      groups.find((group) => group.id === groupId).title = title;
    },
  };
  return { tab, tabs, tabGroups, groups };
}

async function group(fake, { live = () => true, agentGroupIds = [] } = {}) {
  const recorded = [];
  const title = await groupForAgents({
    tab: { ...fake.tab },
    title: "Login",
    agentGroupIds,
    live,
    tabs: fake.tabs,
    tabGroups: fake.tabGroups,
    record: async (groupId) => recorded.push(groupId),
  });
  return { title, recorded };
}

export async function run() {
  // A live link: a new group, named and recorded.
  {
    const fake = fakeChrome();
    const { title, recorded } = await group(fake);
    assert.equal(title, "Login");
    assert.deepEqual(recorded, [100]);
    assert.equal(fake.tab.groupId, 100);
    assert.equal(fake.groups[0].title, "Login");
  }

  // The extension's own group of that title is joined; the user's never is.
  {
    const fake = fakeChrome({ groups: [{ id: 5, title: "login" }, { id: 6, title: "Login" }] });
    const { title, recorded } = await group(fake, { agentGroupIds: [5] });
    assert.equal(title, "login");
    assert.deepEqual(recorded, []);
    assert.equal(fake.tab.groupId, 5);
  }

  // Naming fails while the link is live: as before, the tab stays in the
  // unnamed group and nothing is recorded.
  {
    const fake = fakeChrome({ onUpdate: async () => Promise.reject(new Error("No group with id")) });
    const { title, recorded } = await group(fake);
    assert.equal(title, null);
    assert.deepEqual(recorded, []);
    assert.equal(fake.tab.groupId, 100);
  }

  // The link closes while the group is being named, and naming fails: the
  // tab leaves the group all the same.
  {
    let open = true;
    const fake = fakeChrome({
      onUpdate: async () => {
        open = false;
        throw new Error("No group with id");
      },
    });
    const { title, recorded } = await group(fake, { live: () => open });
    assert.equal(title, null);
    assert.deepEqual(recorded, []);
    assert.equal(fake.tab.groupId, -1, "a rejected rename still undoes the grouping");
  }

  // The link closes while the group is being named, and naming works.
  {
    let open = true;
    const fake = fakeChrome({ onUpdate: async () => (open = false) });
    const { title, recorded } = await group(fake, { live: () => open });
    assert.equal(title, null);
    assert.deepEqual(recorded, [], "the group is not recorded as the agents'");
    assert.equal(fake.tab.groupId, -1);
  }

  // The link closes while the tab joins an existing group.
  {
    let open = true;
    const fake = fakeChrome({ groups: [{ id: 5, title: "Login" }] });
    const join = fake.tabs.group;
    fake.tabs.group = async (options) => {
      const id = await join(options);
      open = false;
      return id;
    };
    const { title } = await group(fake, { live: () => open, agentGroupIds: [5] });
    assert.equal(title, null);
    assert.equal(fake.tab.groupId, -1);
  }

  // The user moved the tab to a group of their own meanwhile: it stays there.
  {
    let open = true;
    const fake = fakeChrome({
      onUpdate: async () => {
        open = false;
        fake.tab.groupId = 9;
      },
    });
    await group(fake, { live: () => open });
    assert.equal(fake.tab.groupId, 9, "only the group this request made is undone");
  }

  return "group tab: an agent's tab joins or makes its group, and a link that closed meanwhile leaves no grouping behind, whether naming the group worked or not";
}
