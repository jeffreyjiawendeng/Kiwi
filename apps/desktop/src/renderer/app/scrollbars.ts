const THUMB_SIZE = 10;
const EDGE_GAP = 2;
const MINIMUM_THUMB = 24;
// How far from the edge a pointer counts as being on the scrollbar. Wider than the thumb,
// because a 10px target is hard to hit deliberately.
const HOVER_ZONE = 16;
const QUIET_DELAY_MS = 700;

type Axis = "vertical" | "horizontal";

interface Metrics {
  offset: number;
  length: number;
  crossOffset: number;
}

function scrollSize(element: HTMLElement, axis: Axis): number {
  return axis === "vertical" ? element.scrollHeight : element.scrollWidth;
}

function visibleSize(element: HTMLElement, axis: Axis): number {
  return axis === "vertical" ? element.clientHeight : element.clientWidth;
}

function scrollOffset(element: HTMLElement, axis: Axis): number {
  return axis === "vertical" ? element.scrollTop : element.scrollLeft;
}

function overflows(element: HTMLElement, axis: Axis): boolean {
  // One pixel of slack: sub-pixel layout routinely reports a scroll size a hair larger
  // than the visible size for content that does not actually overflow.
  return scrollSize(element, axis) - visibleSize(element, axis) > 1;
}

function scrolls(style: CSSStyleDeclaration, axis: Axis): boolean {
  const overflow = axis === "vertical" ? style.overflowY : style.overflowX;
  return overflow === "auto" || overflow === "scroll";
}

// The element a pointer is over may sit many levels inside the region that actually
// scrolls, so the owner of the scrollbar is the nearest ancestor that both scrolls on this
// axis and currently overflows on it.
function nearestScrollable(node: EventTarget | null, axis: Axis, view: Window): HTMLElement | null {
  let element = node instanceof Element ? node : null;
  while (element !== null) {
    if (element instanceof HTMLElement && overflows(element, axis)) {
      if (scrolls(view.getComputedStyle(element), axis)) return element;
    }
    element = element.parentElement;
  }
  return null;
}

// The thumb is drawn over the region's own padding box, never beside it, so revealing it
// costs no layout and content never shifts as a region starts or stops overflowing.
function measure(element: HTMLElement, axis: Axis): Metrics {
  const rect = element.getBoundingClientRect();
  const track = visibleSize(element, axis);
  const total = scrollSize(element, axis);
  const length = Math.max(MINIMUM_THUMB, Math.round((track * track) / total));
  const travel = Math.max(0, track - length);
  const scrolled = Math.max(0, total - track);
  const progress = scrolled === 0 ? 0 : Math.min(1, scrollOffset(element, axis) / scrolled);
  // clientLeft and clientTop are the border widths, which the bounding rect includes and
  // the padding box does not.
  return axis === "vertical"
    ? {
        offset: rect.top + element.clientTop + progress * travel,
        length,
        crossOffset: rect.left + element.clientLeft + element.clientWidth - THUMB_SIZE - EDGE_GAP,
      }
    : {
        offset: rect.left + element.clientLeft + progress * travel,
        length,
        crossOffset: rect.top + element.clientTop + element.clientHeight - THUMB_SIZE - EDGE_GAP,
      };
}

function withinBar(element: HTMLElement, axis: Axis, x: number, y: number): boolean {
  const rect = element.getBoundingClientRect();
  const inside = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  if (!inside) return false;
  return axis === "vertical" ? x >= rect.right - HOVER_ZONE : y >= rect.bottom - HOVER_ZONE;
}

interface Bar {
  readonly axis: Axis;
  readonly node: HTMLElement;
  target: HTMLElement | null;
  hovered: boolean;
  scrolling: boolean;
  dragging: boolean;
  quiet: ReturnType<typeof setTimeout> | null;
  drag: { pointer: number; origin: number; scroll: number } | null;
}

/**
 * Draws one overlay scrollbar per axis, positioned over the region being used.
 *
 * Chromium's own scrollbars occupy layout width whenever they exist, so a region that
 * gains one shifts its content, and reserving the gutter to stop that leaves a permanent
 * empty strip beside every panel. Neither is what a scrollbar should cost. These are drawn
 * on top of the region instead: invisible until the region can scroll and is either being
 * scrolled or has the pointer on its scrollbar.
 */
export function installOverlayScrollbars(doc: Document = document): () => void {
  const defaultView = doc.defaultView;
  if (defaultView === null || doc.body === null) return () => undefined;
  // Bound once so the hoisted handlers below do not each have to re-prove it is present.
  const view: Window = defaultView;

  function createBar(axis: Axis): Bar {
    const node = doc.createElement("div");
    node.className = `kiwi-scrollbar kiwi-scrollbar--${axis}`;
    node.setAttribute("aria-hidden", "true");
    doc.body.append(node);
    return {
      axis,
      node,
      target: null,
      hovered: false,
      scrolling: false,
      dragging: false,
      quiet: null,
      drag: null,
    };
  }

  const bars: Bar[] = [createBar("vertical"), createBar("horizontal")];
  let scheduled = false;

  function paint(bar: Bar): void {
    const target = bar.target;
    const visible =
      target !== null &&
      target.isConnected &&
      overflows(target, bar.axis) &&
      (bar.scrolling || bar.hovered || bar.dragging);
    if (!visible || target === null) {
      bar.node.removeAttribute("data-visible");
      return;
    }
    const metrics = measure(target, bar.axis);
    if (bar.axis === "vertical") {
      bar.node.style.transform = `translate(${metrics.crossOffset}px, ${metrics.offset}px)`;
      bar.node.style.height = `${metrics.length}px`;
      bar.node.style.width = `${THUMB_SIZE}px`;
    } else {
      bar.node.style.transform = `translate(${metrics.offset}px, ${metrics.crossOffset}px)`;
      bar.node.style.width = `${metrics.length}px`;
      bar.node.style.height = `${THUMB_SIZE}px`;
    }
    bar.node.setAttribute("data-visible", "true");
  }

  function render(): void {
    scheduled = false;
    for (const bar of bars) paint(bar);
  }

  // The flag is cleared by the callback, so it has to be set before the callback can run.
  // A frame handle assigned after a synchronous callback would never be cleared again.
  function schedule(): void {
    if (scheduled) return;
    scheduled = true;
    if (typeof view.requestAnimationFrame === "function") view.requestAnimationFrame(render);
    else setTimeout(render, 16);
  }

  function markScrolling(bar: Bar): void {
    bar.scrolling = true;
    if (bar.quiet !== null) clearTimeout(bar.quiet);
    bar.quiet = setTimeout(() => {
      bar.scrolling = false;
      bar.quiet = null;
      schedule();
    }, QUIET_DELAY_MS);
  }

  // Scroll events do not bubble, so the listener has to run in the capture phase.
  function onScroll(event: Event): void {
    const element = event.target;
    if (!(element instanceof HTMLElement)) return;
    for (const bar of bars) {
      if (!overflows(element, bar.axis)) continue;
      if (bar.dragging && bar.target !== element) continue;
      bar.target = element;
      markScrolling(bar);
    }
    schedule();
  }

  function onPointerMove(event: PointerEvent): void {
    for (const bar of bars) {
      if (bar.dragging) continue;
      // While the pointer is on the thumb it is no longer over the region, so the region
      // it describes has to be remembered rather than resolved again.
      if (event.target === bar.node) {
        bar.hovered = true;
        continue;
      }
      const target = nearestScrollable(event.target, bar.axis, view);
      bar.target = target ?? bar.target;
      bar.hovered = target !== null && withinBar(target, bar.axis, event.clientX, event.clientY);
    }
    schedule();
  }

  function onPointerLeave(): void {
    for (const bar of bars) if (!bar.dragging) bar.hovered = false;
    schedule();
  }

  function beginDrag(bar: Bar, event: PointerEvent): void {
    const target = bar.target;
    if (target === null) return;
    event.preventDefault();
    bar.dragging = true;
    bar.drag = {
      pointer: event.pointerId,
      origin: bar.axis === "vertical" ? event.clientY : event.clientX,
      scroll: scrollOffset(target, bar.axis),
    };
    bar.node.setPointerCapture?.(event.pointerId);
    schedule();
  }

  function continueDrag(bar: Bar, event: PointerEvent): void {
    const target = bar.target;
    const drag = bar.drag;
    if (!bar.dragging || target === null || drag === null || drag.pointer !== event.pointerId) {
      return;
    }
    const track = visibleSize(target, bar.axis);
    const total = scrollSize(target, bar.axis);
    const travel = Math.max(1, track - Math.max(MINIMUM_THUMB, (track * track) / total));
    const moved = (bar.axis === "vertical" ? event.clientY : event.clientX) - drag.origin;
    const next = drag.scroll + (moved / travel) * Math.max(0, total - track);
    if (bar.axis === "vertical") target.scrollTop = next;
    else target.scrollLeft = next;
    schedule();
  }

  function endDrag(bar: Bar, event: PointerEvent): void {
    if (!bar.dragging || bar.drag?.pointer !== event.pointerId) return;
    bar.dragging = false;
    bar.drag = null;
    bar.node.releasePointerCapture?.(event.pointerId);
    markScrolling(bar);
    schedule();
  }

  const pointerDownHandlers = bars.map((bar) => {
    const handler = (event: PointerEvent): void => beginDrag(bar, event);
    bar.node.addEventListener("pointerdown", handler);
    return handler;
  });

  function onWindowPointerMove(event: PointerEvent): void {
    for (const bar of bars) continueDrag(bar, event);
  }

  function onWindowPointerUp(event: PointerEvent): void {
    for (const bar of bars) endDrag(bar, event);
  }

  doc.addEventListener("scroll", onScroll, { capture: true, passive: true });
  doc.addEventListener("pointermove", onPointerMove, { passive: true });
  doc.addEventListener("pointerleave", onPointerLeave, { passive: true });
  view.addEventListener("pointermove", onWindowPointerMove);
  view.addEventListener("pointerup", onWindowPointerUp);
  view.addEventListener("pointercancel", onWindowPointerUp);
  view.addEventListener("resize", schedule, { passive: true });

  return () => {
    doc.removeEventListener("scroll", onScroll, { capture: true });
    doc.removeEventListener("pointermove", onPointerMove);
    doc.removeEventListener("pointerleave", onPointerLeave);
    view.removeEventListener("pointermove", onWindowPointerMove);
    view.removeEventListener("pointerup", onWindowPointerUp);
    view.removeEventListener("pointercancel", onWindowPointerUp);
    view.removeEventListener("resize", schedule);
    bars.forEach((bar, index) => {
      const handler = pointerDownHandlers[index];
      if (handler !== undefined) bar.node.removeEventListener("pointerdown", handler);
      if (bar.quiet !== null) clearTimeout(bar.quiet);
      bar.node.remove();
    });
  };
}
