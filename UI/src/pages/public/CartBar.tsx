import { money } from "@rch/domain";

/** The bar along the bottom of the menu once something is in the cart. */
export default function CartBar({ count, total, onReview }: { count: number; total: number; onReview: () => void }) {
  return (
    <div className="qo-bar">
      <div className="qo-col qo-bar-in">
        <p className="qo-bar-sum">
          <span>{count === 1 ? "1 item" : `${count} items`}</span>
          <strong>{money(total)}</strong>
        </p>
        <button type="button" className="qo-btn qo-btn-primary" onClick={onReview}>Review order</button>
      </div>
    </div>
  );
}
