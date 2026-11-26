import type { GuideLine } from "../layout/smartGuides";

export function SmartGuidesOverlay({ guides }: { guides: GuideLine[] }) {
  if (!guides.length) return null;
  return (
    <div className="smart-guides" aria-hidden="true">
      {guides.map((guide) => guide.axis === "v" ? (
        <span
          key={guide.key}
          className={guide.center ? "smart-guide v center" : "smart-guide v"}
          style={{ left: guide.pos, top: guide.start, height: Math.max(0, guide.end - guide.start) }}
        />
      ) : (
        <span
          key={guide.key}
          className={guide.center ? "smart-guide h center" : "smart-guide h"}
          style={{ top: guide.pos, left: guide.start, width: Math.max(0, guide.end - guide.start) }}
        />
      ))}
    </div>
  );
}
