// The editor covers the app, keeps the view's pixel size fixed across window resize, and suspends selection by owner.
export function lockPrintView(mapEl, panel, reactive) {
  const view = mapEl.view, viewpoint = view.viewpoint.clone(), style = { width: mapEl.style.width, height: mapEl.style.height };
  const animationsEnabled = view.animationsEnabled; view.animationsEnabled = false;
  mapEl.style.width = `${view.width}px`; mapEl.style.height = `${view.height}px`;
  panel.setSuspended(true, "print");
  const events = ["drag", "mouse-wheel", "double-click", "key-down"].map((name) => view.on(name, (event) => event.stopPropagation()));
  const gamepad = view.navigation.gamepad, enabled = gamepad.enabled; gamepad.enabled = false;
  const watch = reactive.watch(() => [view.center?.x, view.center?.y, view.scale, view.rotation], () => {
    if (JSON.stringify(view.viewpoint.toJSON()) !== JSON.stringify(viewpoint.toJSON())) view.viewpoint = viewpoint.clone();
  });
  return () => {
    watch.remove(); events.forEach((event) => event.remove()); gamepad.enabled = enabled;
    view.animationsEnabled = animationsEnabled;
    mapEl.style.width = style.width; mapEl.style.height = style.height;
    panel.setSuspended(false, "print");
  };
}
