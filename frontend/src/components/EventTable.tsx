import { useEffect, useRef } from "react";

import type { EventRow } from "../types";

interface EventTableProps {
  rows: EventRow[];
  selectedIndex: number;
  currentFrame: number;
  onSelect: (index: number) => void;
}

function getAnchorFrame(row: EventRow): number | null {
  if (typeof row.synced_frame_id === "number") return row.synced_frame_id;
  if (typeof row.receive_frame_id === "number") return row.receive_frame_id;
  return null;
}

export function EventTable({ rows, selectedIndex, currentFrame, onSelect }: EventTableProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLTableSectionElement | null>(null);
  const rowRefs = useRef<Array<HTMLTableRowElement | null>>([]);

  useEffect(() => {
    const containerEl = containerRef.current;
    const rowEl = rowRefs.current[selectedIndex];
    if (!containerEl || !rowEl) return;

    const containerRect = containerEl.getBoundingClientRect();
    const rowRect = rowEl.getBoundingClientRect();
    const headerHeight = headerRef.current?.getBoundingClientRect().height ?? 0;

    // Keep selected row pinned near the top (right below sticky header).
    const deltaTop = rowRect.top - containerRect.top;
    const targetTop = containerEl.scrollTop + deltaTop - headerHeight;
    containerEl.scrollTop = Math.max(0, targetTop);
  }, [selectedIndex, rows.length]);

  return (
    <div ref={containerRef} className="table-wrap">
      <table className="event-table">
        <thead ref={headerRef}>
          <tr>
            <th>#</th>
            <th>Δ</th>
            <th>period_id</th>
            <th>spadl_type</th>
            <th>player_id</th>
            <th>synced</th>
            <th>receiver_id</th>
            <th>receive</th>
            <th>outcome</th>
            <th>error_type</th>
            <th>note</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const anchorFrame = getAnchorFrame(row);
            const frameDelta = anchorFrame === null ? null : anchorFrame - currentFrame;
            const isFrameMatch = frameDelta !== null && Math.abs(frameDelta) <= 1;
            const isFrameNear = frameDelta !== null && !isFrameMatch && Math.abs(frameDelta) <= 6;

            return (
              <tr
                key={row.id}
                ref={(el) => {
                  rowRefs.current[index] = el;
                }}
                className={[
                  index === selectedIndex ? "selected" : "",
                  isFrameMatch ? "frame-match" : "",
                  isFrameNear ? "frame-near" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={() => onSelect(index)}
              >
                <td>{index + 1}</td>
                <td className={isFrameMatch ? "delta-match" : isFrameNear ? "delta-near" : ""}>
                  {frameDelta === null ? "-" : `${frameDelta > 0 ? "+" : ""}${frameDelta}`}
                </td>
                <td>{row.period_id}</td>
                <td>{row.spadl_type}</td>
                <td>{row.player_id}</td>
                <td>
                  <div className="event-cell-primary">{row.synced_frame_id ?? "-"}</div>
                  <div className="event-cell-secondary">{row.synced_ts ?? "-"}</div>
                </td>
                <td>{row.receiver_id ?? ""}</td>
                <td>
                  <div className="event-cell-primary">{row.receive_frame_id ?? "-"}</div>
                  <div className="event-cell-secondary">{row.receive_ts ?? "-"}</div>
                </td>
                <td>{row.outcome ? "TRUE" : "FALSE"}</td>
                <td>{row.error_type ?? ""}</td>
                <td>{row.note}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
