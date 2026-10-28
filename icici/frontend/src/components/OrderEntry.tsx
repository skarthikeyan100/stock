import { useState, useEffect, useRef, FormEvent } from 'react';
import { InputGroup, Form, Button, Spinner, Alert, ListGroup } from 'react-bootstrap';
import { useTrading } from '../context/TradingContext';
import { useAuth } from '../context/AuthContext';
import { matchSymbols, parsePoints, SYMBOL_SEARCH_MIN_CHARS } from './orderEntryShared';
import { apiFetch } from '../utils/api';
import DemoHelpTip from './DemoHelpTip';
import { DEMO_MAX_LOSS } from '../context/DemoTradingContext';

// One searchable contract: `label` is what the list shows, `value` is what placeContractOrder receives.
interface ContractItem { label: string; value: string }
interface AntOption { token: string; tradingSymbol: string; strike: number; optionType: string }

// `demo`: the anonymous demo page renders this same component (its provider supplies the same trading context). Differences: the
// contract list is the ANT-native /demo/symbols one (symbols.txt is Kite-format and not subscribable on ANT's feed), help bubbles
// explain the controls, the loss limit is the fixed demo one, and no order is ever real.
export default function OrderEntry({ demo }: { demo?: boolean }) {
  const { placeOrder, placeContractOrder, isOrderDisabled, placingOrder, totalPnL, orderError, clearError } = useTrading();
  const { user } = useAuth();

  const [input, setInput] = useState('');
  const [symbols, setSymbols] = useState<ContractItem[]>([]);
  const [suggestions, setSuggestions] = useState<ContractItem[]>([]);
  const [selectedSymbol, setSelectedSymbol] = useState<ContractItem | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [targetPoints, setTargetPoints] = useState('');
  const [stopLossPoints, setStopLossPoints] = useState('');
  const [defaultTargetPoints, setDefaultTargetPoints] = useState<number | null>(null);
  const [defaultStopLossPoints, setDefaultStopLossPoints] = useState<number | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Mirrors the fallback chain manualBuyOnKite/manualBuyOnAnt apply server-side
  // when targetPoints/stopLossPoints are omitted: the user's own override, else
  // config.yml's global settings.targetPoints/stopLossPoints - so the
  // placeholder shows the real value that will be used, not a vague "(default)".
  useEffect(() => {
    if (demo) return; // the demo never applies a fallback target/stop: a blank box places the trade with neither
    apiFetch('/config')
      .then(res => (res.ok ? res.json() : null)) // /config is admin-only: a trader just gets no placeholder hint
      .then(data => {
        if (!data) return;
        setDefaultTargetPoints(data?.settings?.targetPoints ?? data?.settings?.targetPriceDiff ?? null);
        setDefaultStopLossPoints(data?.settings?.stopLossPoints ?? data?.settings?.stopLossPriceDiff ?? null);
      })
      .catch(err => console.error('Failed to load config:', err));
  }, [demo]);

  const effectiveDefaultTarget = demo ? null : (user?.targetPoints ?? defaultTargetPoints);
  const effectiveDefaultStopLoss = demo ? null : (user?.stopLossPoints ?? defaultStopLossPoints);

  // Load symbols list once. Expiry filtering happens server-side now, at
  // generation time (see frontend/update-symbols.sh, which filters Kite's real
  // `expiry` date column) - a client-side regex can't reliably parse
  // Kite's trading symbols the way it could Shoonya's, since Kite uses
  // two different encodings depending on expiry type (e.g. monthly
  // NIFTY26AUG24100CE vs weekly NIFTY2690124100CE).
  useEffect(() => {
    if (demo) {
      apiFetch('/demo/symbols?symbol=NIFTY')
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`status ${res.status}`))))
        .then((data: AntOption[]) => {
          if (Array.isArray(data)) setSymbols(data.map((o) => ({ label: o.tradingSymbol, value: `${o.token}|${o.tradingSymbol}|${o.optionType}` })));
        })
        .catch((err) => console.error('Failed to load demo symbols:', err));
      return;
    }
    apiFetch(import.meta.env.BASE_URL + 'symbols.txt')
      .then(res => res.text())
      .then(text => {
        const lines = text.split('\n').filter(l => l.trim());
        lines.sort();
        setSymbols(lines.map((l) => ({ label: l, value: l })));
      })
      .catch(err => console.error('Failed to load symbols:', err));
  }, [demo]);

  // Close dropdown on outside click
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
    setSelectedSymbol(null);

    const matches = matchSymbols(upper, symbols, (s) => s.label);
    setSuggestions(matches);
    setShowDropdown(matches.length > 0);
  };

  const handleSelect = (item: ContractItem) => {
    setInput(item.label);
    setSelectedSymbol(item);
    setShowDropdown(false);
  };

  const handleContractBuy = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedSymbol) return;
    // Points must be positive finite numbers (a negative/zero value would put the target/stop on the wrong side).
    const { target: tp, stopLoss: sl, error } = parsePoints(targetPoints, stopLossPoints);
    if (error) {
      window.alert(error);
      return;
    }
    // Keep the selection if the order was rejected, so the user can correct and retry.
    const ok = await placeContractOrder(selectedSymbol.value, tp, sl);
    if (ok) {
      setInput('');
      setSelectedSymbol(null);
    }
  };

  const handleTrendBuy = async (right: string) => {
    await placeOrder(right);
  };

  const lossExceeded = totalPnL <= -(demo ? DEMO_MAX_LOSS : (user?.lossLimit ?? 15000));

  return (
    <div>
      {/* Section A: Flash Trade */}
      <fieldset style={{ border: '1px solid #dee2e6', borderRadius: 8, padding: '12px 16px', marginBottom: 16 }}>
        <legend
          className="fw-bold text-muted d-inline-flex align-items-center"
          style={{ width: 'auto', float: 'none', padding: '0 6px', fontSize: '1rem', marginBottom: 8 }}
        >
          Flash Trade
          {demo && <DemoHelpTip text="One-click demo trade: Up buys the at-the-money NIFTY Call, Down buys the at-the-money Put. The position starts pending and fills once a live price is received - no real order is ever placed." />}
        </legend>
        <div className="d-flex align-items-center gap-2 flex-wrap">
          <Button
            variant="success"
            disabled={isOrderDisabled}
            onClick={() => handleTrendBuy('call')}
          >
            {placingOrder ? <Spinner animation="border" size="sm" /> : 'Up'}
          </Button>
          <Button
            variant="danger"
            disabled={isOrderDisabled}
            onClick={() => handleTrendBuy('put')}
          >
            {placingOrder ? <Spinner animation="border" size="sm" /> : 'Down'}
          </Button>
          <small className="text-muted" style={{ fontSize: '0.75rem' }}>
            Predict the trend — buys NIFTY CE or PE {demo ? '(demo)' : 'at market'}
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
          {demo && <DemoHelpTip text={`Type at least ${SYMBOL_SEARCH_MIN_CHARS} characters to search NIFTY option contracts, pick one from the list, optionally set target/stop-loss points, then click Buy. Like Flash Trade, the position fills once a live price is received.`} />}
        </legend>
        <div ref={dropdownRef} style={{ position: 'relative' }}>
          <form onSubmit={handleContractBuy}>
            <InputGroup>
              <Form.Control
                type="text"
                placeholder={demo ? 'e.g. NIFTY 24100 CE' : 'e.g. NIFTY_24100_CE'}
                value={input}
                onChange={(e) => handleInputChange(e.target.value)}
                disabled={isOrderDisabled}
              />
              <Button
                variant="success"
                type="submit"
                disabled={isOrderDisabled || !selectedSymbol}
              >
                {placingOrder ? <Spinner animation="border" size="sm" /> : 'Buy'}
              </Button>
            </InputGroup>
            <div className="d-flex gap-2 mt-2">
              <Form.Control
                type="number"
                size="sm"
                placeholder={effectiveDefaultTarget != null ? `Target pts (default: ${effectiveDefaultTarget})` : 'Target pts'}
                value={targetPoints}
                onChange={(e) => setTargetPoints(e.target.value)}
                disabled={isOrderDisabled}
              />
              <Form.Control
                type="number"
                size="sm"
                placeholder={effectiveDefaultStopLoss != null ? `Stop-loss pts (default: ${effectiveDefaultStopLoss})` : 'Stop-loss pts'}
                value={stopLossPoints}
                onChange={(e) => setStopLossPoints(e.target.value)}
                disabled={isOrderDisabled}
              />
            </div>
          </form>

          {showDropdown && (
            <ListGroup
              style={{
                position: 'absolute',
                zIndex: 1000,
                width: '100%',
                maxHeight: 300,
                overflowY: 'auto',
              }}
            >
              {suggestions.map(item => (
                <ListGroup.Item
                  key={item.value}
                  action
                  onClick={() => handleSelect(item)}
                  style={{ cursor: 'pointer' }}
                >
                  {item.label}
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
        <small className="text-danger mt-1 d-block">
          Maximum loss limit reached. Orders are disabled.
        </small>
      )}
    </div>
  );
}
