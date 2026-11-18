-- KaamSetu Phase 1 / migration 04: reference data.
-- Lives in a migration (not seed.sql) because `supabase db push` does not run
-- seed.sql, and the hosted project needs this data too. Idempotent.
-- Hindi/Gujarati labels are first-pass and should be reviewed by a native speaker.

insert into public.work_categories (slug, name_en, name_hi, name_gu) values
  ('loading_unloading',   'Loading & unloading',  'लोडिंग-अनलोडिंग',   'લોડિંગ-અનલોડિંગ'),
  ('furniture_shifting',  'Furniture shifting',   'फर्नीचर शिफ्टिंग',   'ફર્નિચર શિફ્ટિંગ'),
  ('cleaning',            'Cleaning',             'सफाई',               'સફાઈ'),
  ('event_help',          'Event help',           'इवेंट सहायक',        'ઇવેન્ટ સહાયક'),
  ('construction_helper', 'Construction helper',  'निर्माण सहायक',      'બાંધકામ સહાયક'),
  ('painting_helper',     'Painting helper',      'पेंटिंग सहायक',      'પેઈન્ટિંગ સહાયક'),
  ('gardening',           'Gardening',            'बागवानी',            'બાગકામ'),
  ('packing',             'Packing',              'पैकिंग',             'પેકિંગ')
on conflict (slug) do nothing;

insert into public.localities (city, name) values
  ('Vadodara', 'Akota'),
  ('Vadodara', 'Alkapuri'),
  ('Vadodara', 'Ajwa Road'),
  ('Vadodara', 'Fatehgunj'),
  ('Vadodara', 'Gorwa'),
  ('Vadodara', 'Gotri'),
  ('Vadodara', 'Harni'),
  ('Vadodara', 'Karelibaug'),
  ('Vadodara', 'Makarpura'),
  ('Vadodara', 'Manjalpur'),
  ('Vadodara', 'Nizampura'),
  ('Vadodara', 'Productivity Road'),
  ('Vadodara', 'Race Course'),
  ('Vadodara', 'Sayajigunj'),
  ('Vadodara', 'Subhanpura'),
  ('Vadodara', 'Tarsali'),
  ('Vadodara', 'Vasna'),
  ('Vadodara', 'Waghodia Road')
on conflict (city, name) do nothing;
