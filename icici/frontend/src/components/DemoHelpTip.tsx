import { OverlayTrigger, Tooltip } from 'react-bootstrap';

// Small hover-triggered help bubble - demo page only.
export default function DemoHelpTip({ text }: { text: string }) {
  return (
    <OverlayTrigger placement="top" overlay={<Tooltip>{text}</Tooltip>}>
      <span
        className="text-muted"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 16,
          height: 16,
          borderRadius: '50%',
          border: '1px solid currentColor',
          fontSize: 11,
          lineHeight: 1,
          cursor: 'help',
          marginLeft: 6,
          flex: '0 0 auto',
        }}
      >
        ?
      </span>
    </OverlayTrigger>
  );
}
