-- 0031_city_norm_v2.sql
-- Fixes from the adversarial verification of 0030's city normalization:
--   (1) HIGH: initcap(lower()) flattened interior-capitalized names — 0030's backfill wrote
--       'Mckinney' (3,460 rows), 'Mclean', 'Deland', "O'fallon" etc. (~11k rows), and the
--       trigger kept mangling CORRECT scraper input. v2 titlecases word-wise and PRESERVES
--       well-cased words, so 'McKinney' from the scraper stays 'McKinney'; flat-cased rows
--       are repaired by safe Mc/O' rules + a curated alias table (zip_codes can't serve as a
--       casing dictionary — it is flat-cased itself).
--   (2) State-suffix stripping ("Cape Coral FL") is now case-insensitive but GATED on the
--       remainder being a known city in zip_codes — 'Palomar Mt' survives (no city 'Palomar'),
--       'Greenville Sc' now cleans up, and all-caps ingests can't truncate real names.
--   (3) The city is taken as the part before any comma — 'Atlanta, GA, 30318' -> 'Atlanta',
--       'Jc, Downtown' -> 'Jc' -> alias -> 'Jersey City' (887 rows of JC neighborhoods).
--   (4) Bare zips ('30318') and <=2-char junk ('Na','Gd','Fl') normalize to NULL.
--   (5) Triggers restricted to OF <city columns> so bulk re-ingest updates that don't touch
--       cities skip the normalizer.
-- fn_norm_city is now STABLE (reads city_aliases + zip_codes), not immutable.
-- Idempotent.

set statement_timeout = 600000;

-- ======================= curated aliases =======================
-- Junk shorthands and interior-cap names that no casing rule can produce. Extend as the
-- client reports more (alias_lower must be the LOWERCASED cleaned form).
create table if not exists city_aliases (
  alias_lower text primary key,
  canonical text not null
);
insert into city_aliases (alias_lower, canonical) values
  ('jc', 'Jersey City'),
  ('deland', 'DeLand'),
  ('debary', 'DeBary'),
  ('desoto', 'DeSoto'),
  ('defuniak springs', 'DeFuniak Springs'),
  ('deridder', 'DeRidder'),
  ('lagrange', 'LaGrange'),
  ('labelle', 'LaBelle'),
  ('lasalle', 'LaSalle'),
  ('coeur d''alene', 'Coeur d''Alene'),
  ('land o''lakes', 'Land O'' Lakes'),
  ('land o'' lakes', 'Land O'' Lakes')
on conflict (alias_lower) do update set canonical = excluded.canonical;
grant select on city_aliases to anon, authenticated;

-- existence gate for the no-comma state-suffix strip
create index if not exists idx_zip_codes_lower_city on zip_codes (lower(city));

-- ======================= normalizer v2 =======================
-- Word-wise titlecase that PRESERVES well-cased words: 'McKinney'/'DeLand' pass through,
-- 'BOCA'/'raton'/'bOnita' get initcap. Mc/O' rules repair flat-cased words (incl. rows the
-- 0030 backfill flattened) — safe because no US city is legitimately 'Mc'+lowercase.
create or replace function fn_city_titlecase(p text) returns text
language plpgsql immutable as $$
declare
  w text; t text; out_words text[] := '{}';
begin
  foreach w in array string_to_array(p, ' ') loop
    if w ~ '^[A-Z].*[a-z]' and w !~ '^[A-Z]+$' then
      t := w;                                        -- already well-cased: keep as sent
    elsif w ~ '^([A-Z]\.)+[A-Z]?\.?$' then
      t := w;                                        -- dotted acronym (D.C.)
    else
      t := initcap(lower(w));
    end if;
    if t ~ '^Mc[a-z]' then t := 'Mc' || upper(substring(t, 3, 1)) || substring(t, 4); end if;
    if t ~ '^O''[a-z]' then t := 'O''' || upper(substring(t, 3, 1)) || substring(t, 4); end if;
    out_words := out_words || t;
  end loop;
  return nullif(array_to_string(out_words, ' '), '');
end;
$$;
grant execute on function fn_city_titlecase(text) to anon, authenticated;

create or replace function fn_norm_city(p text) returns text
language plpgsql stable set search_path = public as $$
declare
  x text; base text; cased_base text; canon text;
begin
  x := trim(coalesce(p, ''));
  if x = '' then return null; end if;
  x := regexp_replace(x, '\s*\([^)]*\)\s*$', '');   -- "(City)" parentheticals
  x := trim(split_part(x, ',', 1));                 -- the city is whatever precedes a comma
  x := regexp_replace(x, '\s+\d{5}(-\d{4})?$', ''); -- trailing zip codes
  x := regexp_replace(x, '[\s.,;:]+$', '');         -- trailing punctuation ("Twp.", "Fl.")
  x := trim(regexp_replace(x, '\s+', ' ', 'g'));
  if x = '' or x ~ '^\d+$' then return null; end if;

  select canonical into canon from city_aliases where alias_lower = lower(x);
  if canon is not null then return canon; end if;
  if length(x) <= 2 then return null; end if;       -- 'Na'/'Gd'/'Fl' junk (after aliases, so 'Jc' resolves)

  -- "Cape Coral FL" -> "Cape Coral", but ONLY when the remainder is a known city — otherwise
  -- 'Palomar Mt' would truncate to the nonexistent 'Palomar'. "Known" = in the zip_codes
  -- reference (incomplete — it lacks e.g. Cape Coral and McKinney) OR already present in our
  -- own agents/offices data, compared in FINAL cased form so the check keeps working after
  -- the backfill rewrites stored rows to that form.
  base := regexp_replace(x, '(?i)\s+(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|MD|ME|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC|PR)$', '');
  if base <> x then
    cased_base := fn_city_titlecase(base);
    if exists (select 1 from zip_codes where lower(city) = lower(base))
       or exists (select 1 from agents ag where ag.office_city = cased_base)
       or exists (select 1 from offices o where o.office_city = cased_base) then
      return cased_base;
    end if;
  end if;

  return fn_city_titlecase(x);
end;
$$;
grant execute on function fn_norm_city(text) to anon, authenticated;

-- ======================= triggers: only fire when a city column is written =======================
drop trigger if exists trg_agent_norm_cities on agents;
create trigger trg_agent_norm_cities
  before insert or update of office_city, home_city, most_transacted_city on agents
  for each row execute function fn_agent_norm_cities();

drop trigger if exists trg_office_norm_city on offices;
create trigger trg_office_norm_city
  before insert or update of office_city on offices
  for each row execute function fn_office_norm_city();

-- ======================= re-backfill (repairs 0030's flattening + residual variants) =======================
update agents
   set office_city = fn_norm_city(office_city),
       home_city = fn_norm_city(home_city),
       most_transacted_city = fn_norm_city(most_transacted_city)
 where office_city is distinct from fn_norm_city(office_city)
    or home_city is distinct from fn_norm_city(home_city)
    or most_transacted_city is distinct from fn_norm_city(most_transacted_city);

update offices
   set office_city = fn_norm_city(office_city)
 where office_city is distinct from fn_norm_city(office_city);
