import { textStyle } from "../printTextStyle.js";
import { niceScaleBar } from "../printScaleMath.js";
import { textWidth } from "../pdfFonts.js";
export default {
  id: "scaleBar", label: "Scale bar", defaultSlot: "body", defaultState: { on: true }, controls: [{ type: "text-style", key: "textStyle", profile: "scaleBar", label: "Text style" }],
  measure({ state, box, feetPerInch }) {
    const style = textStyle(state.textStyle, "scaleBar"), scale = niceScaleBar(feetPerInch, Math.max(1, box.width - 24));
    const label = `${scale.units} ${scale.unit}`, readout = `1 in = ${feetPerInch.toLocaleString("en-US", { maximumFractionDigits: 1 })} ft`;
    const overflow = 6 + scale.lengthPt + textWidth(label, style.size, style.bold) / 2 > box.width
      || 6 + textWidth(readout, style.size + 1, style.bold) > box.width;
    return { height: 2 * style.size + 22, width: 200, overflow };
  },
  draw(drawing, box, state, { feetPerInch }) {
    const style = textStyle(state.textStyle, "scaleBar");
    if (box.height < 2 * style.size + 22 || box.width < 40) return;
    const scale = niceScaleBar(feetPerInch, Math.max(1, box.width - 24)), x = box.x + 6, y = box.y + style.size + 7;
    for (let i = 0; i < scale.segments; i++) {
      drawing.rect({ x: x + i * scale.lengthPt / 4, y, width: scale.lengthPt / 4, height: 6 },
        { fill: i % 2 ? "#ffffff" : "#222222", stroke: "#222222", width: 0.5 });
    }
    const labels = ["0", `${scale.units / 2}`, `${scale.units} ${scale.unit}`];
    labels.forEach((label, i) => drawing.text(label, x + i * scale.lengthPt / 2 - (i ? textWidth(label, style.size, style.bold) / 2 : 0), y - 4, style));
    drawing.text(`1 in = ${feetPerInch.toLocaleString("en-US", { maximumFractionDigits: 1 })} ft`, x, y + style.size + 12, { ...style, size: style.size + 1 });
  },
};
