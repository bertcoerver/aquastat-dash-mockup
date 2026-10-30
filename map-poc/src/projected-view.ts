/*
 * A deck.gl View for a ProjectedViewport: deck.gl's own MapController (drag to pan,
 * wheel to zoom about the pointer, right-drag to tilt and turn) drives it through the
 * viewport's panByPosition and unproject, so it needs nothing of its own, except to
 * stand still while the marker is dragged (holdStill).
 */
import { MapController, MapView, View, type MapViewState } from "@deck.gl/core";
import type { ProjectedViewportClass } from "./projected-viewport";

type MapViewProps = NonNullable<ConstructorParameters<typeof MapView>[0]>;
export type ProjectedViewProps = MapViewProps & { viewportClass: ProjectedViewportClass };

let held = false;
/** Hold the map still: its pans are ignored (while the marker is dragged, map.ts). */
export function holdStill(hold: boolean) {
  held = hold;
}

class HoldableController extends MapController {
  handleEvent(event: Parameters<MapController["handleEvent"]>[0]) {
    if (held && event.type.startsWith("pan")) return false;
    return super.handleEvent(event);
  }
}

export class ProjectedView extends View<MapViewState, ProjectedViewProps> {
  static displayName = "ProjectedView";

  getViewportType() {
    return this.props.viewportClass;
  }

  get ControllerType() {
    return HoldableController;
  }
}
