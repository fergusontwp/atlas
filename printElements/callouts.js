import { drawText } from "./text.js";
import { calloutTextStyle } from "../printTextStyle.js";
import { drawLeader, outlineColor } from "../printLeader.js";
import { PRINT } from "../config.js";
import { calloutBox, leaderStart, insideMap } from "../printCalloutMath.js";
export default {
  id: "callouts", label: "Callouts", defaultSlot: "map", required: true,
  defaultState: { on: true, items: [] }, controls: [{ type: "callouts", label: "Add callout" }],
  measure({ box, state, calloutTips }) {
    const boxes = state.items.filter((item) => !calloutTips || insideMap(calloutTips[item.id], box)).map((item) => calloutBox(item, box));
    return { height: Math.max(0, ...boxes.map((item) => item.height)), overflow: boxes.some((item) => item.text.overflow) };
  },
  draw(drawing, map, state, { calloutTips = {} }) {
    for (const item of state.items) {
      const tip = calloutTips[item.id];
      if (!insideMap(tip, map) || !item.text?.trim()) continue;
      const box = calloutBox(item, map), start = leaderStart(box, tip), dark = "#333333";
      const leader = drawLeader(drawing, start, tip, item.leader);
      if (item.arrowhead) {
        const length = Math.hypot(tip.x - start.x, tip.y - start.y);
        if (length > 0) {
          const ux = (tip.x - start.x) / length, uy = (tip.y - start.y) / length;
          drawing.path([tip, { x: tip.x - 6 * ux + 2.5 * uy, y: tip.y - 6 * uy - 2.5 * ux },
            { x: tip.x - 6 * ux - 2.5 * uy, y: tip.y - 6 * uy + 2.5 * ux }], { fill: leader.color, ...(leader.outline ? { stroke: leader.outlineColor ?? outlineColor(leader.color), width: PRINT.LEADER.OUTLINE_PADDING_PT } : {}), close: true });
        }
      }
      if (item.style !== "halo") drawing.rect(box, { fill: "#ffffff", stroke: dark, width: 0.5 });
      const textStyle = calloutTextStyle(item), padding = PRINT.CALLOUT.PADDING_PT;
      drawText({ text: (line, x, y, options) => drawing.text(line, x, y, { ...options, ...(item.style === "halo" ? { halo: "#ffffff", haloWidth: 3 } : {}) }) },
        { x: box.x + padding, y: box.y + padding, width: box.width - 2 * padding, height: box.height - 2 * padding }, { ...box.text, ...textStyle });
    }
  },
};
