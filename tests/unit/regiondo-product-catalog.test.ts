import { describe, expect, it } from 'vitest';
import {
  summarizeRegiondoProductCatalog,
  summarizeRegiondoProductCatalogFromRows
} from '../../src/modules/regiondo/regiondo-product-catalog.js';

describe('summarizeRegiondoProductCatalog', () => {
  it('preserves explicit variation and option titles', () => {
    const summary = summarizeRegiondoProductCatalog({
      variations: [
        {
          options: [
            {
              option_id: '2017401',
              title: 'VIP',
              values: ['vip']
            }
          ],
          title: 'Evening slot',
          variation_id: '720707'
        }
      ]
    });

    expect(summary.variations).toEqual([
      {
        description: null,
        id: '720707',
        label: 'Evening slot',
        options: [
          {
            description: null,
            id: '2017401',
            label: 'VIP',
            values: [{ id: 'vip', label: 'vip' }]
          }
        ],
        price: null,
        values: []
      }
    ]);
    expect(summary.options).toEqual([
      {
        description: null,
        id: '2017401',
        label: 'VIP',
        values: [{ id: 'vip', label: 'vip' }]
      }
    ]);
  });

  it('derives the variation label from variation values when no explicit title exists', () => {
    const summary = summarizeRegiondoProductCatalog({
      variations: [
        {
          values: [{ value: 'Morning' }, { label: 'Weekday' }],
          variation_id: '720707'
        }
      ]
    });

    expect(summary.variations[0]).toMatchObject({
      id: '720707',
      label: 'Morning, Weekday',
      values: ['Morning', 'Weekday']
    });
  });

  it('derives the variation label from linked option values when variation values are missing', () => {
    const summary = summarizeRegiondoProductCatalog({
      variations: [
        {
          options: [
            {
              option_id: '2017401',
              values: ['VIP', 'Standard']
            }
          ],
          variation_id: '720707'
        }
      ]
    });

    expect(summary.variations[0]).toMatchObject({
      id: '720707',
      label: 'VIP, Standard'
    });
  });

  it('derives the option label from option values when no explicit title exists', () => {
    const summary = summarizeRegiondoProductCatalog({
      variations: [
        {
          options: [
            {
              option_id: '2017401',
              values: ['VIP', 'Standard']
            }
          ],
          variation_id: '720707'
        }
      ]
    });

    expect(summary.options).toEqual([
      {
        description: null,
        id: '2017401',
        label: 'VIP, Standard',
        values: [
          { id: 'VIP', label: 'VIP' },
          { id: 'Standard', label: 'Standard' }
        ]
      }
    ]);
  });

  it('falls back to Regiondo identifiers instead of numbered placeholders', () => {
    const summary = summarizeRegiondoProductCatalog({
      variations: [
        {
          options: [{ option_id: '2017401' }],
          variation_id: '720707'
        }
      ]
    });

    expect(summary.variations[0]?.label).toBe('Variation 720707');
    expect(summary.options[0]?.label).toBe('Option 2017401');
    expect(summary.variations[0]?.label).not.toBe('Variation 1');
    expect(summary.options[0]?.label).not.toBe('Option 1');
  });

  it('merges duplicate option ids and keeps the richest label/value set at product level', () => {
    const summary = summarizeRegiondoProductCatalog({
      options: [
        {
          option_id: '2017401',
          values: ['Standard']
        }
      ],
      variations: [
        {
          options: [
            {
              option_id: '2017401',
              title: 'Seating',
              values: ['VIP']
            }
          ],
          variation_id: '720707'
        },
        {
          options: [
            {
              option_id: '2017401',
              values: ['General']
            }
          ],
          variation_id: '720708'
        }
      ]
    });

    expect(summary.options).toHaveLength(1);
    expect(summary.options[0]).toEqual({
      description: null,
      id: '2017401',
      label: 'Seating',
      values: [
        { id: 'Standard', label: 'Standard' },
        { id: 'VIP', label: 'VIP' },
        { id: 'General', label: 'General' }
      ]
    });
  });

  it('builds the same summary contract from normalized variant and option rows', () => {
    const summary = summarizeRegiondoProductCatalogFromRows({
      options: [
        {
          rawJson: {
            description: 'Front-row seat',
            option_id: '2017401',
            values: [{ value: 'VIP' }]
          },
          regiondoOptionId: '2017401',
          regiondoVariantId: '720707',
          title: 'Seat',
          valuesJson: [{ value: 'VIP' }]
        },
        {
          rawJson: {
            description: 'General admission',
            option_id: '2017401',
            values: [{ value: 'General' }]
          },
          regiondoOptionId: '2017401',
          regiondoVariantId: '720708',
          title: null,
          valuesJson: [{ value: 'General' }]
        }
      ],
      variations: [
        {
          price: 19.5,
          rawJson: {
            description: 'Morning slot details',
            values: [{ value: 'Morning' }]
          },
          regiondoVariantId: '720707',
          title: null
        },
        {
          price: 25,
          rawJson: {},
          regiondoVariantId: '720708',
          title: 'Evening'
        }
      ]
    });

    expect(summary.variations).toEqual([
      {
        description: 'Morning slot details',
        id: '720707',
        label: 'Morning',
        options: [
          {
            description: 'Front-row seat',
            id: '2017401',
            label: 'Seat',
            values: [{ id: 'VIP', label: 'VIP' }]
          }
        ],
        price: 19.5,
        values: ['Morning']
      },
      {
        description: null,
        id: '720708',
        label: 'Evening',
        options: [
          {
            description: 'General admission',
            id: '2017401',
            label: 'General',
            values: [{ id: 'General', label: 'General' }]
          }
        ],
        price: 25,
        values: []
      }
    ]);
    expect(summary.options).toEqual([
      {
        description: 'Front-row seat',
        id: '2017401',
        label: 'Seat',
        values: [
          { id: 'VIP', label: 'VIP' },
          { id: 'General', label: 'General' }
        ]
      }
    ]);
  });

  it('preserves descriptive metadata from Regiondo option payloads', () => {
    const summary = summarizeRegiondoProductCatalog({
      variations: [
        {
          description: 'Weekday booking window',
          options: [
            {
              description: 'Up to 30 guests on Wednesday and Thursday',
              option_id: '2017401',
              title: '2 hours'
            }
          ],
          title: 'Weekday pricing',
          variation_id: '720707'
        }
      ]
    });

    expect(summary.variations).toEqual([
      {
        description: 'Weekday booking window',
        id: '720707',
        label: 'Weekday pricing',
        options: [
          {
            description: 'Up to 30 guests on Wednesday and Thursday',
            id: '2017401',
            label: '2 hours',
            values: []
          }
        ],
        price: null,
        values: []
      }
    ]);
    expect(summary.options).toEqual([
      {
        description: 'Up to 30 guests on Wednesday and Thursday',
        id: '2017401',
        label: '2 hours',
        values: []
      }
    ]);
  });
});
