import { useState, useEffect, useRef, FormEvent } from 'react';
import { InputGroup, Form, Button, Spinner, Alert, ListGroup } from 'react-bootstrap';
import { useTrading } from '../context/TradingContext';
import DemoHelpTip from './DemoHelpTip';

interface AntOption {
  token: string;
  tradingSymbol: string;
  strike: number;
  optionType: string;
}

// Demo-mode copy of OrderEntry.tsx - same UI/flow, but the contract search
// sources ANT-native contracts (/demo/symbols) instead of symbols.txt
// (Zerodha-format, not subscribable on ANT's live feed). See
// DemoTradingContext.tsx's header comment.
export default function DemoOrderEntry() {
  const { placeOrder, placeContractOrder, isOrderDisabled, placingOrder, totalPnL, orderError, clearError } = useTrading();

  const [input, setInput] = useState('');
  const [options, setOptions] = useState<AntOption[]>([]);
  const [suggestions, setSuggestions] = useState<AntOption[]>([]);
  const [selected, setSelected] = useState<AntOption | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [targetPoints, setTargetPoints] = useState('');
  const [stopLossPoints, setStopLossPoints] = useState('');
  const [defaultTargetPoints, setDefaultTargetPoints] = useState<number | null>(null);
  const [defaultStopLossPoints, setDefaultStopLossPoints] = useState<number | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch('/demo/symbols?symbol=NIFTY')
      .then((res) => res.json())
      .then((data: AntOption[]) => setOptions(data))
      .catch((err) => console.error('Failed to load demo symbols:', err));
  }, []);

  // Demo mode never actually applies a target/stop-loss fallback (leaving
  // these blank places the trade with neither, see DemoTradingContext's
  // startPendingTrade) - shown here purely so the placeholder matches the
  // live OrderEntry page's copy rather than the vague, unexplained "(default)".
  useEffect(() => {
    fetch('/config')
      .then((res) => res.json())
      .then((data) => {
        setDefaultTargetPoints(data?.settings?.targetPriceDiff ?? null);
        setDefaultStopLossPoints(data?.settings?.stopLossPriceDiff ?? null);
      })
      .catch((err) => console.error('Failed to load config:', err));
  }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleInputChange = (value: string) => {
    const upper = value.toUpperCase();
    setInput(upper);
    setSelected(null);

    if (upper.length >= 2) {
      const terms = upper.split(/\s+/).filter((t) => t);
      const matches = options.filter((o) => terms.every((t) => o.tradingSymbol.toUpperCase().includes(t))).slice(0, 10);
      setSuggestions(matches);
      setShowDropdown(matches.length > 0);
    } else {
      setSuggestions([]);
      setShowDropdown(false);
    }
  };

  const handleSelect = (opt: AntOption) => {
    setInput(opt.tradingSymbol);
    setSelected(opt);
    setShowDropdown(false);
  };

  const handleContractBuy = async (e: FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    await placeContractOrder(
      `${selected.token}|${selected.tradingSymbol}|${selected.optionType}`,
      targetPoints ? Number(targetPoints) : undefined,
      stopLossPoints ? Number(stopLossPoints) : undefined
    );
    setInput('');
    setSelected(null);
  };

  const handleTrendBuy = async (right: string) => {
    await placeOrder(right);
  };

  const lossExceeded = totalPnL <= -15000;

  return (
    <div>
      {/* Section A: Flash Trade */}
      <fieldset style={{ border: '1px solid #dee2e6', borderRadius: 8, padding: '12px 16px', marginBottom: 16 }}>
        <legend
          className="fw-bold text-muted d-inline-flex align-items-center"
          style={{ width: 'auto', float: 'none', padding: '0 6px', fontSize: '1rem', marginBottom: 8 }}
        >
          Flash Trade
          <DemoHelpTip text="One-click demo trade: Up buys the at-the-money NIFTY Call, Down buys the at-the-money Put. The position starts pending and fills once a live price is received - no real order is ever placed." />
        </legend>
        <div className="d-flex align-items-center gap-2 flex-wrap">
          <Button variant="success" disabled={isOrderDisabled} onClick={() => handleTrendBuy('call')}>
            {placingOrder ? <Spinner animation="border" size="sm" /> : 'Up'}
          </Button>
          <Button variant="danger" disabled={isOrderDisabled} onClick={() => handleTrendBuy('put')}>
            {placingOrder ? <Spinner animation="border" size="sm" /> : 'Down'}
          </Button>
          <small className="text-muted" style={{ fontSize: '0.75rem' }}>
            Predict the trend — buys NIFTY CE or PE (demo)
          </small>
        </div>
      </fieldset>

      {/* Section B: Symbol Search */}
      <fieldset style={{ border: '1px solid #dee2e6', borderRadius: 8, padding: '12px 16px', marginBottom: 16 }}>
        <legend
          className="fw-bold text-muted d-inline-flex align-items-center"
          style={{ width: 'auto', float: 'none', padding: '0 6px', fontSize: '1rem', marginBottom: 8 }}
        >
          Search &amp; Buy
          <DemoHelpTip text="Type at least 4 characters to search NIFTY option contracts, pick one from the list, optionally set target/stop-loss points, then click Buy. Like Flash Trade, the position fills once a live price is received." />
        </legend>
        <div ref={dropdownRef} style={{ position: 'relative' }}>
          <form onSubmit={handleContractBuy}>
            <InputGroup>
              <Form.Control
                type="text"
                placeholder="e.g. NIFTY 24100 CE"
                value={input}
                onChange={(e) => handleInputChange(e.target.value)}
                disabled={isOrderDisabled}
              />
              <Button variant="success" type="submit" disabled={isOrderDisabled || !selected}>
                {placingOrder ? <Spinner animation="border" size="sm" /> : 'Buy'}
              </Button>
            </InputGroup>
            <div className="d-flex gap-2 mt-2">
              <Form.Control
                type="number"
                size="sm"
                placeholder={defaultTargetPoints != null ? `Target pts (default: ${defaultTargetPoints})` : 'Target pts'}
                value={targetPoints}
                onChange={(e) => setTargetPoints(e.target.value)}
                disabled={isOrderDisabled}
              />
              <Form.Control
                type="number"
                size="sm"
                placeholder={defaultStopLossPoints != null ? `Stop-loss pts (default: ${defaultStopLossPoints})` : 'Stop-loss pts'}
                value={stopLossPoints}
                onChange={(e) => setStopLossPoints(e.target.value)}
                disabled={isOrderDisabled}
              />
            </div>
          </form>

          {showDropdown && (
            <ListGroup style={{ position: 'absolute', zIndex: 1000, width: '100%', maxHeight: 300, overflowY: 'auto' }}>
              {suggestions.map((opt) => (
                <ListGroup.Item key={opt.token} action onClick={() => handleSelect(opt)} style={{ cursor: 'pointer' }}>
                  {opt.tradingSymbol}
                </ListGroup.Item>
              ))}
            </ListGroup>
          )}
        </div>
      </fieldset>

      {orderError && (
        <Alert variant="danger" className="mt-2 py-2" dismissible onClose={clearError}>
          {orderError}
        </Alert>
      )}
      {lossExceeded && (
        <small className="text-danger mt-1 d-block">Maximum loss limit reached. Orders are disabled.</small>
      )}
    </div>
  );
}
