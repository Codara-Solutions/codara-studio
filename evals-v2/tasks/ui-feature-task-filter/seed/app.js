const tasks = [
  { title: "Write brief", status: "open" },
  { title: "Review proof", status: "done" },
];

function filterTasks(items, status) {
  return items;
}

function render() {
  const list = document.getElementById("tasks");
  if (!list) return;
  list.innerHTML = tasks.map((task) => `<li>${task.title}</li>`).join("");
}

if (typeof document !== "undefined") render();
if (typeof module !== "undefined") module.exports = { filterTasks };

