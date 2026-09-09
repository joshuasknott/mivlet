import madge from "madge";

const roots = [
  "apps/broker/src",
  "apps/desktop/src",
  "packages/connectors/src",
  "packages/knowledge/src",
  "packages/protocol/src",
];

const graph = await madge(roots, {
  fileExtensions: ["ts", "tsx"],
  excludeRegExp: [/(^|[/\\])(dist|target|node_modules|_generated)([/\\]|$)/],
  tsConfig: "apps/desktop/tsconfig.app.json",
});
const cycles = graph.circular();

if (cycles.length > 0) {
  console.error(`Found ${cycles.length} source dependency cycle(s):`);
  for (const cycle of cycles) {
    console.error(`  ${cycle.join(" -> ")} -> ${cycle[0]}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `No source dependency cycles found across ${graph.obj().length ?? Object.keys(graph.obj()).length} modules.`,
  );
}
