// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {
  Widget,
  FlyToInterpolator,
  WebMercatorViewport,
  _GlobeViewport,
  _CRSViewport
} from '@deck.gl/core';
import type {Viewport, WidgetPlacement, WidgetProps} from '@deck.gl/core';
import {render} from 'preact';
import {Tooltip} from './lib/components/tooltip';

export type CompassWidgetProps = WidgetProps & {
  /** Widget positioning within the view. Default 'top-left'. */
  placement?: WidgetPlacement;
  /** View to attach to and interact with. Required when using multiple views. */
  viewId?: string | null;
  /** Tooltip message. */
  label?: string;
  /** Custom tooltip content. Overrides label for tooltip display. */
  tooltip?: string | HTMLElement | false;
  /** Bearing and pitch reset transition duration in ms. */
  transitionDuration?: number;
  /**
   * Callback when the compass reset button is clicked.
   * Called for each viewport that will be reset.
   */
  onReset?: (params: {
    /** The view being reset */
    viewId: string;
    /** The new bearing value (0) */
    bearing: number;
    /** The new pitch value (0 if bearing was already 0) */
    pitch: number;
  }) => void;
};

export class CompassWidget extends Widget<CompassWidgetProps> {
  static defaultProps: Required<CompassWidgetProps> = {
    ...Widget.defaultProps,
    id: 'compass',
    placement: 'top-left',
    viewId: null,
    label: 'Reset Compass',
    tooltip: undefined!,
    transitionDuration: 200,
    onReset: () => {}
  };

  className = 'deck-widget-compass';
  placement: WidgetPlacement = 'top-left';
  viewports: {[id: string]: Viewport} = {};

  constructor(props: CompassWidgetProps = {}) {
    super(props);
    this.setProps(this.props);
  }

  setProps(props: Partial<CompassWidgetProps>) {
    this.placement = props.placement ?? this.placement;
    this.viewId = props.viewId ?? this.viewId;
    super.setProps(props);
  }

  onRenderHTML(rootElement: HTMLElement): void {
    const viewId = this.viewId || Object.values(this.viewports)[0]?.id;
    const widgetViewport = this.viewports[viewId];
    const [rz, rx] = this.getRotation(widgetViewport);
    // Grid-north vs. true-north convergence angle, in degrees, at the CRS view's center -
    // null for non-CRS viewports (Web Mercator/globe have no grid/true distinction).
    const convergence = this.getConvergence(widgetViewport);

    const title =
      convergence === null
        ? this.props.label
        : `${this.props.label} (grid vs. true north: ${convergence >= 0 ? '+' : ''}${convergence.toFixed(2)}°)`;

    const tooltipContent = this.props.tooltip === false ? undefined : (this.props.tooltip ?? title);
    const ui = (
      <div className="deck-widget-button" style={{perspective: 100}}>
        <Tooltip content={tooltipContent}>
          <button
            type="button"
            onClick={() => {
              for (const viewport of Object.values(this.viewports)) {
                this.handleCompassReset(viewport);
              }
            }}
            aria-label={title}
            style={{transform: `rotateX(${rx}deg)`}}
          >
            <svg fill="none" width="100%" height="100%" viewBox="0 0 26 26">
              {/* Primary needle: always grid north (== true north outside CRS views) */}
              <g transform={`rotate(${rz},13,13)`}>
                <path
                  d="M10 13.0001L12.9999 5L15.9997 13.0001H10Z"
                  fill="var(--icon-compass-north-color, rgb(240, 92, 68))"
                />
                <path
                  d="M16.0002 12.9999L13.0004 21L10.0005 12.9999H16.0002Z"
                  fill="var(--icon-compass-south-color, rgb(204, 204, 204))"
                />
              </g>
              {/* Secondary tick: true north in a CRS view, offset from the primary needle
                  by the grid convergence angle at the view center. Omitted entirely
                  outside CRS views (convergence === null), and also skipped when the two
                  norths are indistinguishable at this render scale. */}
              {convergence !== null && Math.abs(convergence) >= 0.05 && (
                <g
                  className="deck-widget-compass-true-north"
                  transform={`rotate(${rz - convergence},13,13)`}
                >
                  <path
                    d="M13 1.5L13 6"
                    stroke="var(--icon-compass-true-north-color, rgb(64, 128, 255))"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </g>
              )}
            </svg>
          </button>
        </Tooltip>
      </div>
    );

    render(ui, rootElement);
  }

  onViewportChange(viewport: Viewport) {
    // no need to update if viewport is the same
    if (!viewport.equals(this.viewports[viewport.id])) {
      this.viewports[viewport.id] = viewport;
      this.updateHTML();
    }
  }

  getRotation(viewport?: Viewport) {
    if (viewport instanceof WebMercatorViewport || viewport instanceof _CRSViewport) {
      return [-viewport.bearing, viewport.pitch];
    } else if (viewport instanceof _GlobeViewport) {
      return [0, Math.max(-80, Math.min(80, viewport.latitude))];
    }
    return [0, 0];
  }

  /** Grid vs. true north convergence angle, in degrees, at the CRS viewport's view
   * center - see `CRSViewport#getConvergence` for the sign convention. `null` for any
   * non-CRS viewport (Web Mercator and globe views have no grid/true north
   * distinction, so the compass has nothing extra to show). */
  getConvergence(viewport?: Viewport): number | null {
    if (viewport instanceof _CRSViewport) {
      return viewport.getConvergence();
    }
    return null;
  }

  handleCompassReset(viewport: Viewport) {
    const viewId = this.viewId || viewport.id;
    if (viewport instanceof WebMercatorViewport || viewport instanceof _CRSViewport) {
      const viewState = this.getViewState(viewId);
      const resetPitch = this.getRotation(viewport)[0] === 0;
      const nextBearing = 0;
      const nextPitch = resetPitch ? 0 : viewport.pitch;

      // Call callback
      this.props.onReset?.({viewId, bearing: nextBearing, pitch: nextPitch});

      const nextViewState = {
        ...viewState,
        bearing: nextBearing,
        ...(resetPitch ? {pitch: nextPitch} : {}),
        transitionDuration: this.props.transitionDuration,
        transitionInterpolator: new FlyToInterpolator()
      };
      this.setViewState(viewId, nextViewState);
    }
  }
}
