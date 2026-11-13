// SDK adapter: load projection once, measure the frame midline in 2271, then apply two measured corrections.
import { GEOREF } from "./config.js";
import { frameMidline } from "./printGeometry.js";
import { correctedViewScale, groundScale } from "./printScaleMath.js";

export function createPrintScale(mapEl) {
  let ready, projection;
  function load() {
    return ready ??= $arcgis.import(["@arcgis/core/geometry/operators/projectOperator.js", "@arcgis/core/geometry/SpatialReference.js"])
      .then(async ([project, SpatialReference]) => {
        await project.load();
        return projection = { project, working: new SpatialReference({ wkid: GEOREF.WORKING_WKID }) };
      }).catch((error) => { ready = null; throw error; });
  }
  async function measure(frame, page, signal) {
    await load();
    signal?.throwIfAborted();
    return measureNow(frame, page);
  }
  function measureNow(frame, page) {
    if (!projection) throw new Error("Print projection is not ready.");
    const { project, working } = projection;
    const points = frameMidline(frame).map((point) => mapEl.view.toMap(point));
    if (points.some((point) => !point)) throw new Error("The map is not ready to measure print scale.");
    const [left, right] = points.map((point) => project.execute(point, working));
    return groundScale(left, right, page.map.width);
  }
  async function setScale(target, getFrame, getPage, signal) {
    const view = mapEl.view, center = view.center.clone(), rotation = view.rotation;
    for (let i = 0; i < 2; i++) {
      const measured = await measure(getFrame(), getPage(), signal);
      signal?.throwIfAborted();
      await view.goTo({ center, rotation, scale: correctedViewScale(view.scale, measured.feetPerInch, target) }, { animate: false, signal });
    }
    const result = await measure(getFrame(), getPage(), signal);
    if (Math.abs(result.feetPerInch / target - 1) > 0.005) throw new Error("This scale is outside the map's zoom range.");
    return result;
  }
  return { measure, measureNow, setScale };
}
