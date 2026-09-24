import { money } from "@rch/domain";

/**
 * The floating bar along the bottom of the menu once something is in the cart. The total is
 * keyed on its value so each change replays a short tick (CSS only, and none under reduced motion).
 */
export default function CartBar({ count, total, onReview }: { count: number; total: number; onReview: () => void }) {
  return (
    <div className="qo-bar">
      <div className="qo-col">
        <div className="qo-bar-in">
          <span className="qo-bar-count" aria-hidden="true">{count}</span>
          <p className="qo-bar-sum">
            <span>{count === 1 ? "1 item" : `${count} items`}</span>
            <strong key={total}>{money(total)}</strong>
          </p>
          <button type="button" className="qo-btn qo-bar-go" onClick={onReview}>Review order</button>
        </div>
      </div>
    </div>
  );
}
