"use strict";

/// A very small value we use to determine fuzzy equality of points. Floating-point arithmetic is
/// imprecise, so we have to take slight inequalities into account when computing.
const EPSILON = 10 ** (-10);
const INV_EPSILON = 1 / EPSILON;

/// A flat symmetric quadratic Bézier curve.
class Bezier {
    constructor(origin, w, h, angle) {
        this.origin = origin;
        [this.w, this.h] = [w, h];
        this.angle = angle;

        // Computed properties.
        this.end = this.origin.add(new Point(this.w, 0));
        // The control point.
        this.control = this.origin.add(new Point(this.w / 2, this.h));
    }

    /// Returns the (x, y)-point at t = `t`.
    point(t) {
        return this.origin.lerp(this.control, t).lerp(this.control.lerp(this.end, t), t);
    }

    /// Returns the angle of the tangent to the curve at t = `t`.
    tangent(t) {
        return this.control.lerp(this.end, t).sub(this.origin.lerp(this.control, t)).angle();
    }

    /// Returns the Bézier curve from t = 0 to t = `t` as a series of points corresponding
    /// to line segments, and their total length.
    /// Returns `{ points, length }`.
    delineate(t) {
        // How many pixels of precision we want for the length.
        const EPSILON = 0.25;

        // Start with a single, linear segment.
        const points = [[0, this.point(0)], [t, this.point(t)]];

        let previous_length;
        let length = 0;

        do {
            // Calculate the current approximation of the arc length.
            previous_length = length;
            length = 0;
            for (let i = 0; i < points.length - 1; ++i) {
                length += points[i + 1][1].sub(points[i][1]).length();
            }
        } while (length - previous_length > EPSILON && (() => {
            // If we're still not within the required precision, double the number of segments.
            for (let i = 0; i < points.length - 1; ++i) {
                const t = (points[i][0] + points[i + 1][0]) / 2;
                points.splice(++i, 0, [t, this.point(t)]);
            }
            return true;
        })());

        return { points, length };
    }

    /// Returns the arc length of the Bézier curve from t = 0 to t = `t`.
    /// These Bézier curves are symmetric, so t = `t` to t = 1 can be calculated by inverting the
    /// arc length from t = 0.
    arc_length(t) {
        const { length } = this.delineate(t);
        return length;
    }

    /// Returns a function giving the parameter t of the point a given length along the arc of
    /// the Bézier curve. (It returns a function, rather than the t for a length, to allow
    /// the segments to be cached for efficiency).
    /// The returned function does no error-checking, so the caller is responsible for ensuring it
    /// is passed only lengths between 0 and the arc length of the curve.
    t_after_length() {
        const { points } = this.delineate(1);
        return (length) => {
            let distance = 0;
            for (let i = 0; i < points.length - 1; ++ i) {
                const segment_length = points[i + 1][1].sub(points[i][1]).length();
                if (distance + segment_length >= length) {
                    // Lerp the t parameter.
                    return points[i][0]
                        + (points[i + 1][0] - points[i][0]) * (length - distance) / segment_length;
                }
                distance += segment_length;
            }
        };
    }

    /// Intersect the Bézier curve with the given rounded rectangle. Note that the general
    /// (analytic) problem of intersecting a Bézier curve with a circle is very difficult, so we
    /// approximate circles with regular polygons.
    intersections_with_rounded_rectangle(rect) {
        // There is one edge case in the following computations, which occurs when the height of the
        // Bézier curve is zero (i.e. the curve is a straight line). We special-case this type of
        // curve, and do not normalise its height.
        const h = this.h || 1;

        // Normalise all the points with respect to the Bézier curve. From this point on, we do
        // all computations with respect to `NormalisedBezier` for simplicity.
        const points = rect.points().map((p) => {
            // Translate the point with respect to the origin.
            p = p.sub(this.origin);
            // Rotate -θ around the origin.
            p = p.rotate(-this.angle);
            // Scale the point horizontally and vertically.
            p = p.inv_scale(this.w, h);
            return p;
        });

        const intersections = new Set();

        const add_intersection = (p) => {
            // We round intersection points to `EPSILON`, so that we don't unnecessary add
            // points that are essentially equal.
            intersections.add(new Point(
                Math.round(p.x * INV_EPSILON) / INV_EPSILON,
                Math.round(p.y * INV_EPSILON) / INV_EPSILON,
            ));
        };

        // Calculate the `m` and `c` in `y = m x + c`, given two points on the line.
        const m_c = (endpoints) => {
            const m = (endpoints[1].y - endpoints[0].y) / (endpoints[1].x - endpoints[0].x);
            return { m, c: endpoints[0].y - m * endpoints[0].x };
        };

        if (this.h === 0) {
            // Special-case a straight line, as we can't normalise with respect to this curve.
            // This means we're trying to intersect `rect` with a horizontal line (0, 0) to (1, 0).
            for (let i = 0; i < points.length; ++i) {
                const endpoints = [points[i], points[(i + 1) % points.length]];
                if (Math.abs(endpoints[0].x - endpoints[1].x) <= EPSILON) {
                    // `x = a`.
                    if (
                        endpoints[0].x >= 0 && endpoints[0].x <= 1
                        && Math.min(endpoints[0].y, endpoints[1].y) <= 0
                        && Math.max(endpoints[0].y, endpoints[1].y) >= 0
                    ) {
                        add_intersection(new Point(endpoints[0].x, 0));
                    }
                } else {
                    // `y = m x + c`.
                    const { m, c } = m_c(endpoints);
                    if (Math.abs(m) > EPSILON) {
                        // The line is diagonal and will thus intersect the rectangle at at most one
                        // point.
                        const x = -c / m;
                        if (
                            x >= 0 && x <= 1
                            && x >= Math.min(endpoints[0].x, endpoints[1].x)
                            && x <= Math.max(endpoints[0].x, endpoints[1].x)
                        ) {
                            add_intersection(new Point(x, 0));
                        }
                    } else if (Math.abs(endpoints[0].y) <= EPSILON) {
                        // The lines lies along one of the lines making up the rectangle. There are
                        // thus an infinite number of intersections. In this case, we return just
                        // those extremal points.
                        const min = Math.min(endpoints[0].x, endpoints[1].x);
                        const max = Math.max(endpoints[0].x, endpoints[1].x);
                        if (min <= 1 && max >= 0) {
                            add_intersection(new Point(Math.max(min, 0), 0));
                            add_intersection(new Point(Math.min(max, 1), 0));
                        }
                    }
                }
            }
        } else {
            // The usual case: when we have a nontrivial Bézier curve.
            for (let i = 0; i < points.length; ++i) {
                const endpoints = [points[i], points[(i + 1) % points.length]];
                if (Math.abs(endpoints[0].x - endpoints[1].x) <= EPSILON) {
                    // `x = a`.
                    const y = NormalisedBezier.y_intersection_with_vertical_line(endpoints[0].x);
                    if (
                        y >= 0
                        && y >= Math.min(endpoints[0].y, endpoints[1].y)
                        && y <= Math.max(endpoints[0].y, endpoints[1].y)
                    ) {
                        // `y` must be at most `0.5`.
                        add_intersection(new Point(endpoints[0].x, y));
                    }
                } else {
                    // `y = m x + c`.
                    const { m, c } = m_c(endpoints);
                    NormalisedBezier.x_intersections_with_nonvertical_line(m, c)
                        .filter((x) => {
                            return x >= 0 && x <= 1
                                && x >= Math.min(endpoints[0].x, endpoints[1].x)
                                && x <= Math.max(endpoints[0].x, endpoints[1].x);
                        })
                        .map((x) => new Point(x, m * x + c))
                        .forEach((int) => add_intersection(int));
                }
            }
        }

        return Array.from(intersections).map((p) => {
            // The derivative of the normalised Bézier curve is `2 - 4x`.
            return new BezierPoint(p.scale(this.w, h), p.x, Math.atan2((2 - 4 * p.x) * h, this.w));
        });
    }
}

/// A point on a quadratic Bézier curve, which also records the angle of the curve at the point.
class BezierPoint extends Point {
    constructor(point, t, angle) {
        super(point.x, point.y);
        this.t = t;
        this.angle = angle;
    }
}

/// A quadratic Bézier curve whose endpoints are `(0, 0)` and `(1, 0)` and whose control point
/// is `(0.5, 1)`. The highest point on the curve is therefore `(0.5, 0.5)`. The equation of the
/// curve is `y = 2 x (1 - x)`. This makes the mathematics much simpler than dealing with arbitrary
/// Bézier curves all the time.
class NormalisedBezier {
    /// Returns the `x` co-ordinates of the intersection with the line `y = m x + c`.
    static x_intersections_with_nonvertical_line(m, c) {
        const determinant = m ** 2 - 4 * m + 4 - 8 * c;
        if (determinant > 0) {
            return [(2 - m + determinant ** 0.5) / 4, (2 - m - determinant ** 0.5) / 4];
        } else if (determinant === 0) {
            return [(2 - m + determinant ** 0.5) / 4];
        } else {
            return [];
        }
    }

    /// Returns the `y` co-ordinates of the intersection with the line `x = a`.
    static y_intersection_with_vertical_line(a) {
        return 2 * a * (1 - a);
    }
}

class RoundedRectangle {
    /// Create a rounded rectangle with centre `(cx, cy)`, width `w`, height `h` and border radius
    /// `r`.
    constructor(cx, cy, w, h, r) {
        [this.x, this.y] = [cx, cy];
        [this.w, this.h] = [w, h];
        this.r = r;
    }

    /// Returns the points forming the rounded rectangle (with an approximation for the rounded
    /// corners).
    /// `min_segment_length` specifies the precision of the approximation, as the maximum length of
    /// any straight line used to approximate a curve. This must be greater than zero.
    points(max_segment_length = 5) {
        const points = [];

        // The lower bound on the number of sides the corner polygons have, in order to limit the
        // maximum length of any side to `max_segment_length`. We use these polygons to approximate
        // circles.
        const n = this.r !== 0 ? Math.PI / Math.atan(max_segment_length / (2 * this.r)) : 0;
        // The actual number of sides the polygons have.
        const sides = Math.ceil(n);
        // The length from the centre of the polygon to a corner. Note that we want to
        // over-approximate circles (i.e. the circles should be contained within the polygons),
        // rather than under-approximate them, which is why we use `R` rather than `this.r` for the
        // polygon radius.
        const R = this.r / Math.cos(Math.PI / sides);

        /// `sx` and `sy` are the signs for the side of the rectangle for which we're drawing
        /// a corner.
        const add_corner_points = (sx, sy, angle_offset) => {
            points.push(new Point(
                this.x + (this.w / 2 - this.r) * sx + Math.cos(angle_offset) * this.r,
                this.y + (this.h / 2 - this.r) * sy + Math.sin(angle_offset) * this.r,
            ));
            for (let i = 0; i < sides / 4; ++i) {
                const angle = (i + 0.5) / sides * 2 * Math.PI + angle_offset;
                points.push(new Point(
                    this.x + (this.w / 2 - this.r) * sx + Math.cos(angle) * R,
                    this.y + (this.h / 2 - this.r) * sy + Math.sin(angle) * R,
                ));
            }
            angle_offset += Math.PI / 2;
            points.push(new Point(
                this.x + (this.w / 2 - this.r) * sx + Math.cos(angle_offset) * this.r,
                this.y + (this.h / 2 - this.r) * sy + Math.sin(angle_offset) * this.r,
            ));
            return angle_offset;
        }

        let angle_offset = 0;

        // Bottom-right corner.
        angle_offset = add_corner_points(1, 1, angle_offset);

        // Bottom-left corner.
        angle_offset = add_corner_points(-1, 1, angle_offset);

        // Top-left corner.
        angle_offset = add_corner_points(-1, -1, angle_offset);

        // Top-right corner.
        angle_offset = add_corner_points(1, -1, angle_offset);

        // Remove zero-length segments. These can occur when the border radius is very small.
        for (let i = points.length - 2; i >= 0; --i) {
            if (Math.abs(points[i].x - points[i + 1].x) <= EPSILON
                && Math.abs(points[i].y - points[i + 1].y) <= EPSILON
            ) {
                points.splice(i + 1, 1);
            }
        }

        return points;
    }
}
