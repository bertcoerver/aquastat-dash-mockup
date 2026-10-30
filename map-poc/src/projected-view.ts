/*
 * A deck.gl View for a ProjectedViewport: deck.gl's own MapController (drag to pan,
 * wheel to zoom about the pointer, right-drag to tilt and turn) drives it through the
 * viewport's panByPosition and unproject, so it needs nothing of its own.
 */
import { MapController, View, type MapViewState } from "@deck.gl/core";
import type { CommonViewProps } from "../node_modules/@deck.gl/core/dist/views/view";
import type { ProjectedViewportClass } from "./projected-viewport";

export type ProjectedViewProps = CommonViewProps<MapViewState> & {
  viewportClass: ProjectedViewportClass;
};

export class ProjectedView extends View<MapViewState, ProjectedViewProps> {
  static displayName = "ProjectedView";

  getViewportType() {
    return this.props.viewportClass;
  }

  get ControllerType() {
    return MapController;
  }
}
