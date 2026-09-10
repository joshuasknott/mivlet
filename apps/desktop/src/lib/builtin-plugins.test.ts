import { describe,expect,it } from "vitest";
import { builtinPluginMentions,builtinPluginInstructions,mentionedBuiltinPlugins } from "./builtin-plugins";
describe("native Computer Use workflow",()=>{
  it("offers only the enabled Computer Use plugin",()=>{expect(builtinPluginMentions({computer:true}).map(p=>p.id)).toEqual(["computer"]);expect(builtinPluginMentions({computer:false})).toEqual([]);});
  it("recognizes a complete mention and follows the global approval policy",()=>{expect(mentionedBuiltinPlugins("use @computer, please")).toHaveLength(1);expect(mentionedBuiltinPlugins("@computerish")).toEqual([]);expect(builtinPluginInstructions("@computer",{computer:true},["local-app-observe"])).toContain("global approval policy");});
  it("requires enablement and a capable executing route",()=>{expect(()=>builtinPluginInstructions("@computer",{computer:false},["local-app-observe"])).toThrow("Enable");expect(()=>builtinPluginInstructions("@computer",{computer:true},[])).toThrow("model route");});
});
