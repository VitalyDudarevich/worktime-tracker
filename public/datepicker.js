// A small English calendar for a text field that holds a YYYY-MM-DD date.
// The browser's own date picker follows the system language, and a page can't switch it to English.
import { isoDay, parseDay } from './time.js';

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

function button(text, onClick, label) {
  const node = document.createElement('button');
  node.type = 'button';
  node.textContent = text;
  if (label) node.setAttribute('aria-label', label);
  node.addEventListener('click', onClick);
  return node;
}

function span(text, className) {
  const node = document.createElement('span');
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

/**
 * Opens a month grid under `input` on click or ArrowDown. Picking a day writes it into the field
 * and fires "change", the same as typing a date and leaving the field. Escape or a click elsewhere closes it.
 */
export function attachDatePicker(input) {
  const popup = document.createElement('div');
  popup.className = 'datepicker';
  popup.hidden = true;
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-label', 'Choose a date');
  input.after(popup);
  input.setAttribute('aria-haspopup', 'dialog');
  input.setAttribute('aria-expanded', 'false');
  let month; // the first day of the month on screen

  // The head and foot are built once and only the grid is redrawn, so focus stays on ‹ or › while paging.
  const title = span('');
  const head = document.createElement('div');
  head.className = 'dp-head';
  head.append(button('‹', () => show(-1), 'Previous month'), title, button('›', () => show(1), 'Next month'));
  const grid = document.createElement('div');
  grid.className = 'dp-grid';
  const foot = document.createElement('div');
  foot.className = 'dp-foot';
  foot.append(button('Today', event => pick(isoDay(new Date()), event)), button('Clear', event => pick('', event)));
  popup.append(head, grid, foot);

  function setOpen(open) {
    popup.hidden = !open;
    input.setAttribute('aria-expanded', String(open));
  }

  // Focus goes back to the field only after a keyboard pick: on a phone it would pop up the keyboard again.
  function pick(day, event) {
    input.value = day;
    setOpen(false);
    if (event.detail === 0) input.focus();
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function show(delta = 0) {
    month = new Date(month.getFullYear(), month.getMonth() + delta, 1);
    title.textContent = month.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    const selected = parseDay(input.value);
    const today = isoDay(new Date());
    const blanks = (month.getDay() + 6) % 7; // the grid starts on Monday
    const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();

    const days = Array.from({ length: daysInMonth }, (_, i) => {
      const date = new Date(month.getFullYear(), month.getMonth(), i + 1);
      const day = isoDay(date);
      const label = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
      const node = button(String(i + 1), event => pick(day, event), label);
      if (day === selected) {
        node.classList.add('selected');
        node.setAttribute('aria-pressed', 'true');
      }
      if (day === today) {
        node.classList.add('today');
        node.setAttribute('aria-current', 'date');
      }
      return node;
    });
    grid.replaceChildren(...WEEKDAYS.map(w => span(w, 'dp-weekday')), ...Array.from({ length: blanks }, () => span('')), ...days);
  }

  function open() {
    const day = parseDay(input.value);
    const base = day ? new Date(`${day}T00:00:00`) : new Date();
    month = new Date(base.getFullYear(), base.getMonth(), 1);
    show();
    setOpen(true);
  }

  input.addEventListener('click', open);
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); open(); }
  });
  // Escape closes the calendar wherever focus is, including <body> after a click inside it.
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || popup.hidden) return;
    const focusInside = popup.contains(document.activeElement) || document.activeElement === document.body;
    setOpen(false);
    if (focusInside) input.focus();
  });
  document.addEventListener('mousedown', event => {
    if (!popup.hidden && !popup.contains(event.target) && event.target !== input) setOpen(false);
  });
  input.form?.addEventListener('reset', () => setOpen(false));
}
