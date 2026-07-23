-- Companion to 20260723090000: a time_only promise carries NO promised day
-- (there is no day to promise), so the pairing check gains the exception.
-- Same lenient shape as the original ('none' or promised_day is not null):
-- levels that carry a day must have one; the day-less levels tolerate either,
-- with the application always writing NULL for them (bookVisit/moveVisit/
-- set_promise share one carriesPromisedDay predicate).
alter table assignments drop constraint promised_day_when_promised;
alter table assignments add constraint promised_day_when_promised
  check (promise_level in ('none', 'time_only') or promised_day is not null);
