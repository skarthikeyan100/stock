import { useState, useEffect, useRef, FormEvent } from 'react';
import { InputGroup, Form, Button, Spinner, Alert, ListGroup } from 'react-bootstrap';
import { useTrading } from '../context/TradingContext';
import { useAuth } from '../context/AuthContext';

export default function OrderEntry() {
  const { placeOrder, placeContractOrder, isOrderDisabled, placingOrder, totalPnL, orderError, clearError } = useTrading();
  const { user } = useAuth();

  const [input, setInput] = useState('');
  const [symbols, setSymbols] = useState<string[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [selectedSymbol, setSelectedSymbol] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Load symbols list once, filtering out expired contracts
  useEffect(() => {
    fetch(import.meta.env.BASE_URL + 'symbols.txt')
      .then(res => res.text())
      .then(text => {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const months: Record<string, number> = {
          JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
          JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
        };
        const lines = text.split('\n').filter(l => {
          if (!l.trim()) return false;
          const match = l.match(/(\d{2})([A-Z]{3})(\d{2})[CP]/);
          if (!match) return true;
          const [, dd, mon, yy] = match;
          const monthIdx = months[mon];
          if (monthIdx === undefined) return true;
          const expiry = new Date(2000 + parseInt(yy), monthIdx, parseInt(dd));
          return expiry >= today;
        });
        lines.sort();
        setSymbols(lines);
      })
      .catch(err => console.error('Failed to load symbols:', err));
  }, []);

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
    setSelectedSymbol('');

    if (upper.length >= 4) {
      const terms = upper.split(/\s+/).filter(t => t);
      const matches = symbols.filter(s => terms.every(t => s.includes(t))).slice(0, 10);
      setSuggestions(matches);
      setShowDropdown(matches.length > 0);
    } else {
      setSuggestions([]);
      setShowDropdown(false);
    }
  };

  const handleSelect = (sym: string) => {
    setInput(sym);
    setSelectedSymbol(sym);
    setShowDropdown(false);
  };

  const handleContractBuy = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedSymbol) return;
    await placeContractOrder(selectedSymbol);
    setInput('');
    setSelectedSymbol('');
  };

  const handleTrendBuy = async (right: string) => {
    await placeOrder(right);
  };

  const lossExceeded = totalPnL <= -(user?.lossLimit ?? 15000);

  return (
    <div>
      {/* Section A: Flash Trade */}
      <div className="d-flex align-items-center gap-2 mb-3">
        <span className="fw-bold text-muted text-nowrap">Flash Trade</span>
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
        <small className="text-muted text-nowrap" style={{ fontSize: '0.75rem' }}>
          Predict the trend — buys NIFTY CE or PE at market
        </small>
      </div>

      {/* Section B: Symbol Search */}
      <div ref={dropdownRef} style={{ position: 'relative' }}>
        <form onSubmit={handleContractBuy}>
          <InputGroup>
            <Form.Control
              type="text"
              placeholder="e.g. NIFTY10FEB26P21000"
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
            {suggestions.map(sym => (
              <ListGroup.Item
                key={sym}
                action
                onClick={() => handleSelect(sym)}
                style={{ cursor: 'pointer' }}
              >
                {sym}
              </ListGroup.Item>
            ))}
          </ListGroup>
        )}
      </div>

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
