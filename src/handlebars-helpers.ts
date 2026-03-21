import handlebars from 'handlebars';
import helpers from 'handlebars-helpers';
import { formatDate, formatDistanceToNow } from 'date-fns';

let helpersRegistered = false;

export function registerHandlebarsHelpers() {
  if (helpersRegistered) {
    return;
  }

  helpers();

  handlebars.registerHelper('howLongAgo', (date: string) => {
    return formatDistanceToNow(new Date(date), { addSuffix: true });
  });

  handlebars.registerHelper('formatDate', (date: string, formatString?: string) => {
    return formatDate(
      new Date(date),
      formatString && typeof formatString === 'string' ? formatString : 'MM/dd/yyyy HH:mm:ss aaa',
    );
  });

  handlebars.registerHelper('formatCents', (cents: number) => {
    if (cents === undefined || cents === null) {
      return 'N/A';
    }

    const dollars = cents / 100;
    return `$${dollars.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  });

  handlebars.registerHelper('eq', (a: unknown, b: unknown) => a === b);
  helpersRegistered = true;
}
