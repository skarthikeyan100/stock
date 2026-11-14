import { useState } from 'react';
import { Modal } from 'react-bootstrap';
import { useAuth } from '../context/AuthContext';

// Short, plain-language answers for the controls on the trading page, all shown at once.
// [question, answer, optional link]
const ITEMS: Array<[string, string, string?]> = [
  ['What is an option?', 'An option is a bet on where the market will go. If the market moves the way you guessed, your option becomes worth more and you can sell it for a profit.'],
  ['What are CE and PE?', 'CE (Call) is a bet that the market will go UP. PE (Put) is a bet that the market will go DOWN. Pick CE if you think it will rise, PE if you think it will fall.'],
  ['How do I use Flash Trade?', 'Flash Trade is the quick way. Press Up if you think the market will rise, or Down if you think it will fall. It buys right away. Use "Settings" next to it to change how much it buys and your target and stop loss.'],
  ['How do I use Search & Buy?', 'Type the first 3 letters of a stock or index, for example TCS or NIFTY, and pick a contract from the list. You will see its price, strike and expiry. Fill in a target and stop loss if you want, then press Buy.'],
  ['What is a target point?', 'It is the profit you want. If you set 20, the platform sells for you once the price has gone up by 20 points, so you keep that gain.'],
  ['What is a stop loss?', 'It is your safety net. If you set 10, the platform sells for you once the price has gone down by 10 points, so a bad trade cannot hurt you more than that.'],
  ['Want to learn options?', 'A free, step-by-step course on how options work:', 'https://zerodha.com/varsity/module/option-theory/'],
];

// Shown to Advanced accounts (and admins) only: they are the ones who can choose fixed lots and set their own stop-loss.
const ADVANCED_ITEMS: Array<[string, string]> = [
  ['Trade limit and fixed-lot mode', 'In investment-amount mode you can place at most 3 trades a day. Fixed-lot mode (1 lot every time) has no daily trade cap, but your daily and weekly loss limits and the per-trade loss cap still apply.'],
  ['Why was my position smaller than my capital?', 'Your position is sized so one stopped-out trade cannot lose more than the per-trade percentage of your capital shown in the Beginner / Advanced table, so a cheap option with a wide stop-loss buys fewer lots.'],
];

// A "?" help icon for the page header; clicking it opens every question and answer at once.
export default function TradingFaq() {
  const [show, setShow] = useState(false);
  const { user, isAdmin } = useAuth();
  const items: Array<[string, string, string?]> = isAdmin || user?.proficiencyLevel === 'advanced' ? [...ITEMS, ...ADVANCED_ITEMS] : ITEMS;
  return (
    <>
      <button
        type="button"
        className="btn btn-outline-secondary btn-sm rounded-circle p-0 fw-bold"
        style={{ width: 28, height: 28, lineHeight: 1 }}
        title="Help"
        aria-label="Help"
        onClick={() => setShow(true)}
      >
        ?
      </button>
      <Modal show={show} onHide={() => setShow(false)} centered scrollable>
        <Modal.Header closeButton><Modal.Title>Help</Modal.Title></Modal.Header>
        <Modal.Body>
          {items.map(([q, a, link]) => (
            <div key={q} className="mb-3">
              <div className="fw-semibold">{q}</div>
              <div className="small text-muted">{a}{link && <> <a href={link} target="_blank" rel="noopener noreferrer">Zerodha Varsity: Option Theory</a></>}</div>
            </div>
          ))}
        </Modal.Body>
      </Modal>
    </>
  );
}
