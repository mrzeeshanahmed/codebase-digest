import { OutputFormatter } from './types';
import { MarkdownFormatter } from './markdownFormatter';
import { TextFormatter } from './textFormatter';
import { JsonFormatter } from './jsonFormatter';

export function getFormatter(format: 'markdown' | 'text' | 'json'): OutputFormatter {
    if (format === 'text') { return new TextFormatter(); }
    if (format === 'json') { return new JsonFormatter(); }
    return new MarkdownFormatter();
}
