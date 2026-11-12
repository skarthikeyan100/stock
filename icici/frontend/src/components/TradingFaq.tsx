import { Accordion } from 'react-bootstrap';

// Short, plain-language answers for the controls on the trading page.
const ITEMS: Array<[string, string]> = [
  ['What is an option?', 'An option is a ticket that bets on where the market will go. You pay a small price for the ticket now. If the market moves the way you guessed, the ticket becomes worth more and you can sell it for a profit. If not, you lose only what you paid.'],
  ['What are CE and PE?', 'CE (Call) is a bet that the market will go UP. PE (Put) is a bet that the market will go DOWN. Pick CE if you think it will rise, PE if you think it will fall.'],
  ['How do I use Flash Trade?', 'Flash Trade is the quick way. Press Up if you think the market will rise (it buys a NIFTY CE) or Down if you think it will fall (it buys a NIFTY PE). It buys right away at the market price. Use "Settings" there to change how much it buys and your target and stop loss.'],
  ['How do I use Search & Buy?', 'Type the first 3 letters of a stock or index, for example TCS or NIFTY, and pick a contract from the list. You will see its price, strike and expiry. Fill in a target and stop loss if you want, then press Buy.'],
  ['What is a target point?', 'It is the profit you want. If you set 20, the platform sells for you once the price has gone up by 20 points, so you keep that gain.'],
  ['What is a stop loss?', 'It is your safety net. If you set 10, the platform sells for you once the price has gone down by 10 points, so a bad trade cannot hurt you more than that.'],
];

export default function TradingFaq() {
  return (
    <Accordion className="mb-3">
      <Accordion.Item eventKey="faq">
        <Accordion.Header>FAQ - how this page works</Accordion.Header>
        <Accordion.Body className="p-0">
          <Accordion flush>
            {ITEMS.map(([q, a], i) => (
              <Accordion.Item eventKey={String(i)} key={q}>
                <Accordion.Header>{q}</Accordion.Header>
                <Accordion.Body className="small">{a}</Accordion.Body>
              </Accordion.Item>
            ))}
          </Accordion>
        </Accordion.Body>
      </Accordion.Item>
    </Accordion>
  );
}
