# Custom boards (HTML & CSS) and deleting a channel

## Custom boards

A custom board is a dashboard widget that you design yourself in HTML and CSS. Live readings are put in with placeholders.

### Add one

1. Open a channel → **Dashboard** → **Edit dashboard** → **Add widget**.
2. Open the **Templates** tab and choose **Custom board (HTML & CSS)**.
3. Pick a starting template:

   | Template | What it looks like |
   |---|---|
   | Hero reading | One big live value on a blue–violet gradient |
   | Room monitor | Two readings side by side, each with a fill bar |
   | Lab board | Every sensor field in a dark instrument panel, with the device's online status |
   | Control status | A lamp that lights up when a control (like `led`) is on |
   | Blank | A minimal starting point |

4. Edit the **HTML** and **CSS** tabs. The **Live preview** on the right updates as you type, using the device selected on the dashboard.
5. Set the **Height** in pixels. To show only your design, without the widget's title bar, leave **Title** empty.
6. Click **Add widget**, then **Save dashboard**.

### Placeholders

Write a field's firmware name (as it appears under Channel settings → Fields) or `fieldN` between double braces:

| Placeholder | Gives |
|---|---|
| `{{temperature}}` | Latest value, rounded to the field's decimals |
| `{{temperature.unit}}`, `{{temperature.label}}` | The field's unit and label |
| `{{temperature.time}}` | How long ago it was sent ("12 s ago") |
| `{{temperature.percent}}` | 0–100, scaled between the field's min and max. Useful for bars: `style="width: {{humidity.percent}}%"` |
| `{{temperature.raw}}` | The unrounded number |
| `{{led.on}}` | `on`, `off` or `unset`. Useful as a CSS class: `<div class="lamp {{led.on}}">` |
| `{{device.name}}`, `{{device.status}}`, `{{device.seen}}` | Device name; `online`, `offline` or `unknown`; time of the last message |
| `{{now}}` | Current time |

A name that doesn't match any field shows `—`.

### Example

```html
<div class="card {{device.status}}">
  <span>{{field1.label}}</span>
  <b>{{field1}} {{field1.unit}}</b>
  <div class="bar"><i style="width: {{field2.percent}}%"></i></div>
</div>
```

```css
.card { padding: 18px; border-radius: 14px; background: linear-gradient(135deg, #e5ebff, #fff); }
.card.offline { filter: grayscale(1); opacity: .6; }
.card b { display: block; font-size: 42px; }
.bar { height: 8px; background: #e7ebf1; border-radius: 99px; }
.bar i { display: block; height: 100%; background: #3157f6; border-radius: 99px; }
```

### Limits and safety

- Each board can have up to 20,000 characters of HTML and 20,000 of CSS.
- Boards run in a locked sandbox: `<script>` and `onclick=` code don't run, and a board can't read your session or call the API. Values are inserted as text, so a reading can never inject HTML.
- Images and fonts load only from `https://` or `data:` addresses.
- Switches and sliders that *change* values stay as normal Control widgets (Controls tab). A custom board *shows* values, including control states through `{{led.on}}`.

## Deleting a channel

1. Open the channel → **Channel settings**.
2. In **Delete this channel**, click **Delete channel…**.
3. Type the channel's exact name, then click **Delete forever**.

This permanently removes:
- every device in the channel, along with its keys (boards still using those keys get `401` errors);
- all stored readings, the fields and the dashboard;
- the channel's rules, alerts, commands and LMS links.

API keys that were limited to this channel alone are revoked. Keys that also cover other channels keep working for those channels.

Only organization **Admins** can delete a channel. To keep the data, first download it from **API keys & export → Download CSV**. The deletion is recorded in the **Audit log**.

API: `DELETE /api/v1/projects/{id}` with body `{"confirmName": "<exact channel name>"}`.
