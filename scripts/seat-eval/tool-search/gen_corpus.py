import json, os
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "corpus.jsonl")
rows = []
def F(cat, hard, text, needs, also, note, ctx=None):
    c = None
    if ctx:
        c = [{"role": "user" if i % 2 == 0 else "assistant", "text": t} for i, t in enumerate(ctx)]
    rows.append({"category": cat, "hard": hard, "context": c, "text": text,
                 "needs": needs.split() if needs else [], "alsoOk": also.split() if also else [], "note": note})

S="schedule_read"
F(S,0,"whats on today","get_team_schedule","resolve_date","counts page defaults to firm-local today")
F(S,0,"who's going where today","get_team_schedule","resolve_date","stops:true for customers/addresses")
F(S,0,"what's jane got tmrw","resolve_date get_team_schedule","list_team","relative day then stops for tech-jane")
F(S,0,"how busy is next week","resolve_date get_team_schedule","","week:1 range then counts page")
F(S,0,"anything unassigned?","get_team_schedule","query_spine","unassignedOnly:true")
F(S,0,"whats this week look like","resolve_date get_team_schedule","","week:0 range")
F(S,0,"is tom becker still on for today","find_customer get_customer_context","get_team_schedule resolve_date","per-customer upcomingVisits")
F(S,0,"when's acme's next visit","find_customer get_customer_context","get_team_schedule","Acme has open work but no visit; openWorkNote answers")
F(S,0,"busiest day next week?","resolve_date get_team_schedule","","use counts verbatim, never tally")
F(S,1,"how many visits did jane do last month","resolve_date query_spine","","past month beyond schedule read; v_visit_participants joined to v_schedule")
F(S,0,"any visits with no time set yet","get_team_schedule","query_spine","unassignedOnly lists untimed visits")
F(S,0,"janes schedule friday","resolve_date get_team_schedule","","weekday resolve then stops technicianRef")
F(S,0,"what did we have on monday","resolve_date get_team_schedule","query_spine","past monday weeksAhead -1")
F(S,0,"show me the stops for thursday","resolve_date get_team_schedule","","stops:true")
F(S,0,"who's on saturday","resolve_date get_team_schedule","get_availability","what is booked, not working pattern")
F(S,0,"any open jobs nobody's booked yet","get_team_schedule","query_spine","unassignedOnly jobs queue")
F(S,1,"how many visits got cancelled this month","resolve_date query_spine","","v_cancelled_visits; schedule read excludes cancelled")
F(S,1,"list every visit for jane in the next 3 weeks","resolve_date get_team_schedule","query_spine","14-day cap means two pages/ranges")
F(S,0,"whats left for today","get_team_schedule","resolve_date","stops with completed flags")
F(S,0,"did jane finish the becker visit","find_customer get_customer_context","get_team_schedule get_job list_recent_captures","lastVisitAt / visit status")
F(S,0,"schedule for the 30th?","resolve_date get_team_schedule","","explicitDate needs the month resolved")
F(S,1,"compare this week to last week","resolve_date get_team_schedule","query_spine","two week ranges, counts verbatim")
F(S,0,"anything overdue that nobody went to","get_team_schedule","query_spine","unassignedOnly overdue:true parked visits")
F(S,0,"whos on the acme job","find_customer get_customer_context","get_team_schedule query_spine","crew per job")
F(S,0,"what time is jane at toms","find_customer get_customer_context","get_team_schedule resolve_date","upcomingVisits carries time")
F(S,0,"how many jobs we got open right now","query_spine","get_team_schedule","count over v_jobs by status")
F(S,1,"which visits this week still dont have a note from the tech","resolve_date query_spine","","v_schedule stage happened vs reported")
F(S,1,"is next tuesday packed","resolve_date get_team_schedule","","next tuesday ambiguous: resolve weeksAhead 0 and 1, answer both")
F(S,0,"morning. what we got","get_team_schedule","resolve_date","today's schedule")
F(S,0,"day after tomorrow schedule pls","resolve_date get_team_schedule","","dayShift 2")
F(S,0,"jane in the field today or off?","get_team_schedule","get_availability resolve_date","booked stops; time off via get_availability")
F(S,0,"how many visits has sam done since june","resolve_date query_spine","","window must end at resolve_date today")
F(S,0,"send me the board link","get_team_schedule","","boardNote comes with every schedule read")
F(S,0,"whats first thing tmrw","resolve_date get_team_schedule","","stops for tomorrow")
F(S,0,"how many trips in august by each tech","query_spine","resolve_date","group by person via v_visit_participants")
F(S,0,"anything booked for acme at all?","find_customer get_customer_context","get_team_schedule","upcomingVisits empty + openWorkNote")
F(S,0,"whats jane doing rest of the week","resolve_date get_team_schedule","","week range, technicianRef")
F(S,1,"who's the unassigned one","get_team_schedule","resolve_date","follow-up: stops/unassignedOnly for the date just given",
  ["whats on tomorrow","Thursday 2026-09-24: 3 visits, 2 with Jane, 1 with nobody on it."])
F(S,1,"and the week after?","resolve_date get_team_schedule","","follow-up: week:2 range",
  ["how busy next week","Monday 2026-09-28 through Sunday 2026-10-04: 9 visits, busiest is Tuesday with 3."])
F(S,1,"wheres the second one","get_team_schedule","find_customer get_customer_context","follow-up: stops give the address",
  ["whats jane got today","Jane has 2 stops today: Tom Becker 9:00-11:00 furnace inspection, then 1:00-2:30 a drain call."])

B="booking"
F(B,0,"book tom becker tmrw 9 to 11 with jane","resolve_date find_customer book_visit","get_customer_context get_job list_team","book by jobId of open furnace job")
F(B,1,"put acme on for next thursday 1-4pm, nobody on it yet","resolve_date find_customer book_visit","get_customer_context ask_user","next thursday ambiguous: ask before booking; book unassigned")
F(B,0,"when can jane fit the acme maintenance","find_customer find_slots","get_customer_context","find_slots is the only scheduling truth")
F(B,0,"find me a slot for acme this week, its 2 hrs","resolve_date find_customer find_slots","get_customer_context","durationMinutes 120, window from resolve_date")
F(B,0,"move toms visit today to friday same time","resolve_date get_team_schedule move_visit","find_customer get_customer_context get_job list_recent_captures","visitId from schedule, read record before moving")
F(B,1,"cancel toms visit today, he'll call to rebook","get_team_schedule unschedule_visit","find_customer get_customer_context resolve_date","visit only, work continues: not cancel_job")
F(B,0,"tom becker doesnt want the furnace job anymore, kill it","find_customer get_customer_context cancel_job","get_job","whole work cancelled, two-step")
F(B,1,"cancel the beckers","find_customer","get_customer_context ask_user","ambiguous visit vs job: must ask")
F(B,1,"put jane on the acme visit","get_team_schedule","find_customer get_customer_context move_visit book_visit ask_user","Acme has no visit yet; attach via move_visit if parked else book")
F(B,1,"add sam to jane's 9am at beckers","get_team_schedule move_visit","find_customer get_customer_context list_team","technicianRefs with BOTH; not a second booking")
F(B,0,"book acme oct 6 8am-12pm, jane and sam both going","find_customer book_visit","resolve_date get_customer_context list_team","one visit with technicianRefs")
F(B,0,"book maria gonzalez a new job water heater flush monday 10-11","resolve_date find_customer book_visit","get_customer_context","new title mints new job")
F(B,1,"new customer Dave Lin 44 Oak St, leaking pipe, can someone go tmrw 2-3","resolve_date find_customer record_field_note book_visit","ask_user","no customer yet: record creates with confirm, then book")
F(B,0,"book acme in, we'll figure out the day later","find_customer book_visit","get_customer_context","untimed:true")
F(B,1,"push everything jane has tomorrow to friday","resolve_date get_team_schedule move_visit","get_job list_recent_captures","multi visit move")
F(B,1,"jane's sick tmrw, unassign her stuff","resolve_date add_time_off get_team_schedule move_visit","inform_team_lead","time off plus unassign:true for each visit")
F(B,0,"can we get someone to toms before friday for a 1 hr thing","resolve_date find_customer find_slots","get_customer_context","find_slots by jobId, 60 min")
F(B,0,"move acme visit to the 2nd at 10","resolve_date get_team_schedule move_visit","find_customer get_customer_context","explicit day needs the month")
F(B,1,"book tom a follow up next week whenever jane is free, 90 min","resolve_date find_customer find_slots book_visit","get_customer_context","find then book")
F(B,0,"schedule a return trip to marias for the AC, thurs 3-5","resolve_date find_customer book_visit","get_customer_context get_job","return visit uses existing jobId")
F(B,0,"put the acme job on the calendar in 3 days 8-10","resolve_date find_customer book_visit","get_customer_context","dayShift 3")
F(B,1,"tom called, wants to push to next week sometime","resolve_date get_team_schedule find_slots","find_customer get_customer_context move_visit ask_user","vague: offer slots for the visit, confirm before moving")
F(B,1,"book jane at beckers friday","resolve_date find_customer","get_customer_context ask_user","no times given: must ask, never guess")
F(B,0,"unassign jane from the tom becker visit","get_team_schedule move_visit","find_customer get_customer_context","unassign:true parks it")
F(B,0,"swap jane off the acme visit and put sam on","get_team_schedule move_visit","find_customer get_customer_context list_team","technicianRef replaces crew")
F(B,0,"can u move todays becker thing an hour later","get_team_schedule move_visit","resolve_date find_customer get_customer_context get_job","same day shift")
F(B,1,"book acme quarterly for the first monday of next month 9-12","resolve_date find_customer book_visit","get_customer_context","month:1 then first monday, never self-computed")
F(B,0,"whats the soonest anyone can get to acme","find_customer find_slots","get_customer_context","ranked candidates")
F(B,1,"does jane have room tmrw afternoon for a 1 hr at marias","resolve_date find_customer find_slots","get_customer_context","bookability is find_slots, not get_availability")
F(B,0,"take the acme visit off the calendar, they asked us to hold","get_team_schedule unschedule_visit","find_customer get_customer_context inform_team_lead","work stays open, two-step")
F(B,1,"book tom for the same time next week as today","resolve_date get_team_schedule find_customer book_visit","get_customer_context","needs today's time and +7 date")
F(B,1,"do the first one","book_visit","","follow-up: book the offered slot verbatim",
  ["when can jane fit acme","Top options: Thursday 2026-09-24 10:00-12:00 with Jane (near her 9am), Friday 2026-09-25 13:00-15:00 with Jane."])
F(B,1,"8 to 10","book_visit","resolve_date","follow-up: times supplied",
  ["book tom becker friday with jane","Friday is 2026-09-25. What times should I book?"])
F(B,1,"just the visit","unschedule_visit","get_team_schedule","follow-up: visit, not job",
  ["cancel the beckers","Do you mean take today's furnace inspection visit off the calendar (the job stays open) or cancel the whole furnace job?"])
F(B,1,"the whole thing","cancel_job","get_customer_context","follow-up: cancel the job, two-step",
  ["cancel the beckers","Do you mean take today's furnace inspection visit off the calendar (the job stays open) or cancel the whole furnace job?"])
F(B,1,"yep","unschedule_visit","","follow-up: confirmId on explicit yes",
  ["unschedule toms visit","This takes Tom Becker's furnace inspection today 9:00-11:00 off the calendar. The job goes back to the loose bucket. Confirm?"])
F(B,1,"the later one","move_visit","resolve_date get_team_schedule","follow-up: chosen date, now move",
  ["move toms visit to next friday 10-12","Next Friday could be Friday 2026-09-25 or Friday 2026-10-02. Which one?"])
F(B,1,"book 2 guys for acme next wed all day 8-4","resolve_date find_customer book_visit","list_team get_customer_context ask_user","crew visit; next wed ambiguous, ask")
F(B,1,"the acme job takes 3 hrs, find me something next week","resolve_date find_customer find_slots","update_job get_customer_context","duration stated: durationMinutes 180")
F(B,0,"tom needs another visit to finish up, jane, oct 1 1-3pm","find_customer book_visit","get_customer_context resolve_date","same furnace jobId, not new job")
F(B,0,"move janes 2pm to sam","get_team_schedule move_visit","resolve_date list_team","reassign crew")
F(B,1,"give every unassigned visit to jane","get_team_schedule move_visit","","unassignedOnly then attach each")
F(B,1,"get it on the books for jane asap","find_slots book_visit","find_customer get_customer_context","follow-up: slots for the unbooked Acme job",
  ["whats unassigned","1 job with no visit: Acme Offices quarterly maintenance. No parked visits."])
F(B,1,"tonight 7-9 no heat at the beckers, send jane","resolve_date find_customer book_visit","get_customer_context","tonight = today; hidden date")
F(B,1,"actually make it 10-12","move_visit","get_team_schedule","follow-up: move the just-booked visit",
  ["book acme tmrw 9-11 with jane","Booked Acme Offices quarterly maintenance Thursday 2026-09-24 09:00-11:00 with Jane."])

A="availability"
F(A,0,"jane's on vacation oct 5 to oct 9","add_time_off","resolve_date","explicit inclusive range")
F(A,0,"jane's off friday","resolve_date add_time_off","","single day")
F(A,0,"what hours does jane work","get_availability","","configured pattern")
F(A,0,"set jane mon-fri 7 to 3:30","set_availability","","all seven day keys")
F(A,0,"cancel jane's time off next week, she's coming in","resolve_date remove_time_off","get_availability","date inside the range")
F(A,0,"who works saturdays","get_availability","","whole roster")
F(A,0,"let techs see 6 weeks ahead","set_technician_horizon","","weeks:6")
F(A,1,"how far out can jane see the schedule","get_team_schedule","","horizon has no getter; schedule read carries technicianHorizonDays")
F(A,0,"jane has a dentist appt tmrw, whole day","resolve_date add_time_off","","dayShift 1")
F(A,0,"jane is doing 4 10s now, mon-thu 7-5:30","set_availability","","new weekly pattern")
F(A,1,"is jane free thursday afternoon","resolve_date get_team_schedule","get_availability find_slots","no job subject: booked stops plus pattern")
F(A,0,"sam off oct 12 thru 16","add_time_off","list_team resolve_date","manager on roster too")
F(A,0,"installs take 6 hrs by default","set_job_duration","","type default, 360 minutes")
F(A,0,"maintenance jobs are 90 min","set_job_duration","","type default")
F(A,1,"oh and saturdays 8 to noon","set_availability","get_availability","follow-up: re-send full pattern incl sat",
  ["set jane mon fri 8-5","Stored for Jane: Mon-Fri 08:00-17:00; Sat, Sun off."])

C="customers_jobs"
F(C,0,"pull up tom becker","find_customer get_customer_context","","contents page")
F(C,0,"whats the deal with acme","find_customer get_customer_context","","contents page")
F(C,0,"find the customer on 12 elm street","find_customer","query_spine","address search")
F(C,0,"whos 555-0142","find_customer","query_spine","phone search")
F(C,0,"what notes do we have on toms furnace job","find_customer get_customer_context list_recent_captures","","notes page by jobId")
F(C,1,"open a job for acme: replace rooftop unit, just a quote for now","find_customer open_job","get_customer_context","nobody going; refused on open work, forceNewJob since different")
F(C,0,"rename the acme job to Q4 maintenance","find_customer get_customer_context update_job","","title fix")
F(C,1,"toms inspection is gonna take 2 hrs","find_customer get_customer_context update_job","","durationMinutes on job, not a standing fact")
F(C,0,"make the becker job urgent","find_customer get_customer_context update_job","","priority")
F(C,0,"acme cancelled their contract, close out the maintenance job","find_customer get_customer_context cancel_job","","terminal, two-step")
F(C,0,"what did jane write on the last becker visit","find_customer get_customer_context list_recent_captures","get_capture","newest notes")
F(C,1,"read me that whole note","get_capture","","follow-up: captureId from context page",
  ["whats new on becker","Newest note from Jane yesterday: 'Heat exchanger looks rough, rust along the seam, recommend...' (cut off)."])
F(C,0,"how many customers do we have","query_spine","","count v_customers")
F(C,0,"list all jobs still open","query_spine","get_team_schedule","v_jobs by status")
F(C,0,"any customers in springfield","query_spine","find_customer","city filter")
F(C,0,"whats marias email","find_customer","get_customer_context query_spine","profile")
F(C,0,"did maria say anything about the AC since","find_customer get_customer_context","list_recent_captures get_job","correspondence on job")
F(C,1,"show me toms older jobs","find_customer query_spine","get_customer_context","olderJobs is a count only; list via v_jobs")
F(C,0,"mark acme as emergency, their server room AC is down","find_customer get_customer_context update_job","book_visit find_slots","priority change")
F(C,0,"open a plumbing job for maria, slow drain, no rush","find_customer open_job","get_customer_context","no visit yet")
F(C,1,"job type should be plumbing not hvac","update_job","","follow-up: fix jobType on the job just opened",
  ["open a job for maria slow drain","Opened 'slow drain' for Maria Gonzalez, type hvac, routine."])
F(C,0,"whos our newest customer","query_spine","","order by created_at")
F(C,1,"wrong title, its slow kitchen drain","update_job","","follow-up: title correction",
  ["open a job for maria slow drain","Opened 'slow drain' for Maria Gonzalez, type plumbing, routine."])
F(C,1,"search our notes for anyone mentioning a dog","query_spine","","free text over v_captures")
F(C,1,"did the office ever close out the maria thing","find_customer get_customer_context","get_job ask_team_lead","vague: job status first")
F(C,0,"what did the customer say on the acme job","find_customer get_customer_context get_job","list_recent_captures","attributes.correspondence")
F(C,1,"yeah thats his son, same house, link it to tom","find_customer record_caller","","follow-up: office unknown-caller item, link existing customer",
  ["any office stuff","The office has an unknown caller from 555-0199 who says he's Tom Becker's son calling about the furnace. Is that Tom's household?"])
F(C,1,"yes create her and open a job, nobody going yet","record_caller","","follow-up: newCustomer + openJob, bookVisit false",
  ["anything from the office","A caller at 555-0123, Linda Park, isn't on file. She wants a quote on a new boiler. Want me to create her as a customer?"])
F(C,1,"yeah shes new, send jane out thursday morning 9-11","record_caller resolve_date move_visit","get_team_schedule","follow-up: create + untimed trip, then place it on thursday",
  ["anything from the office","A caller at 555-0123, Linda Park, isn't on file. She wants a quote on a new boiler. Want me to create her as a customer?"])
F(C,0,"is there a job for the carlsons","find_customer","query_spine","likely not on file")
F(C,1,"open a job for toms water heater, send jane monday 8-10","resolve_date find_customer book_visit","get_customer_context","someone going: book_visit mints the job, not open_job")
F(C,0,"whens the last time we were at marias","find_customer get_customer_context","query_spine","lastVisitAt")
F(C,0,"how long is the acme job set for","find_customer get_customer_context get_job","query_spine","duration on the job")
F(C,0,"what jobs does jane have going","query_spine","get_team_schedule","cross-cutting list")
F(C,0,"look up becker, anything owed?","find_customer get_customer_context","get_job","moneyByJob")

M="money"
F(M,0,"maria paid 450 by check #1043","find_customer get_customer_context record_money_event","get_job","payment_received 45000, externalRef")
F(M,0,"what does maria owe","find_customer get_customer_context","get_job","balance due from money summary")
F(M,0,"invoice tom 280 for the inspection","find_customer get_customer_context record_money_event","get_job","invoice_issued; status follows ledger")
F(M,0,"parts on the becker job were 65 bucks","find_customer get_customer_context record_money_event","","material_cost; balance unchanged")
F(M,0,"gave acme an estimate for 3200","find_customer get_customer_context record_money_event","","estimate_presented")
F(M,1,"acme said yes to the estimate","find_customer get_customer_context record_money_event","get_job query_spine","estimate_approved needs the amount from the ledger")
F(M,1,"knock 50 off marias invoice","find_customer query_spine record_money_event","get_customer_context get_job","correction cancels whole entry, then re-issue lower")
F(M,0,"total collected this month","resolve_date query_spine","","payment_received minus refunds in window")
F(M,0,"who owes us money","query_spine","","balances across jobs")
F(M,0,"refund maria 100 on her card","find_customer get_customer_context record_money_event","","payment_refunded")
F(M,1,"the 450 i logged for maria was wrong, it was 405","find_customer query_spine record_money_event","get_customer_context get_job","correction + new payment")
F(M,0,"write off the rest of marias balance","find_customer get_customer_context record_money_event","get_job","write_off for balance amount")
F(M,0,"acme paid a 500 deposit by ach","find_customer get_customer_context record_money_event","","payment_received")
F(M,1,"bill acme 1500 as the first milestone","find_customer get_customer_context record_money_event","","invoice_issued progress:true")
F(M,0,"revenue last quarter","resolve_date query_spine","","quarter:-1 window")
F(M,0,"void toms invoice, went to the wrong guy","find_customer query_spine record_money_event","get_customer_context get_job","invoice_voided with correctsEventId")
F(M,0,"how much did parts cost us on marias AC job","find_customer get_customer_context","get_job","materialCostCents")
F(M,1,"whats our margin on marias job","find_customer get_customer_context","get_job","no labour: must not call it margin")
F(M,0,"change order on becker +350 for a new igniter","find_customer get_customer_context record_money_event","","change_order")
F(M,0,"tom declined the estimate","find_customer get_customer_context record_money_event","","estimate_declined")
F(M,0,"75 trip charge on becker","find_customer get_customer_context record_money_event","","fee_charged")
F(M,1,"maria paid in full cash yesterday","resolve_date find_customer get_customer_context record_money_event","get_job","occurredAt from resolved date; amount = balance")
F(M,0,"any invoices over 30 days unpaid","resolve_date query_spine","","window from resolved today")
F(M,0,"total material costs this year","resolve_date query_spine","","material_cost only")
F(M,1,"oops that was check 1044 not cash","record_money_event","query_spine get_job","follow-up: correct whole entry and re-enter",
  ["maria paid 450 cash","Recorded a $450 cash payment on Maria Gonzalez's AC repair. Balance due is now $0."])
F(M,1,"and he paid it on the spot, card","record_money_event","","follow-up: payment_received 28000 same job",
  ["invoice tom 280","Recorded a $280 invoice on Tom Becker's furnace inspection. Status is invoiced, balance due $280."])
F(M,1,"marias check bounced","find_customer query_spine record_money_event","get_customer_context get_job","correction of the payment entry")
F(M,0,"give acme a 100 credit for the delay","find_customer get_customer_context record_money_event","","credit_applied")
F(M,1,"how much have we invoiced on janes jobs this month","resolve_date query_spine","","join money to visits by tech")
F(M,1,"tom paid 280, and mark his inspection done","find_customer get_customer_context record_money_event","get_job","no status tool: ledger moves status")

X="files"
F(X,0,"make me a pdf invoice for maria","find_customer get_customer_context run_command","get_job query_spine set_firm_profile write_file share_file","data + letterhead then build PDF")
F(X,1,"pdf invoice for maria and email it to her","find_customer get_customer_context run_command share_file","get_job query_spine set_firm_profile write_file send_email","send_email has no attachments; share_file sends it")
F(X,0,"spreadsheet of all jobs this month","resolve_date query_spine run_command","write_file share_file","xlsx build")
F(X,0,"xlsx of payments last quarter and send it to my accountant jen@cpafirm.com","resolve_date query_spine run_command share_file","write_file","sent out")
F(X,0,"weekly summary of janes visits as a pdf","resolve_date get_team_schedule run_command","query_spine write_file share_file","schedule data to PDF")
F(X,0,"export the customer list as csv","query_spine run_command","write_file share_file","csv build")
F(X,1,"write up a quick summary of the becker job","find_customer get_customer_context","list_recent_captures get_job","text reply in chat, no file needed")
F(X,0,"estimate pdf for acme rooftop unit 3200","find_customer get_customer_context run_command","set_firm_profile query_spine write_file record_money_event share_file","estimate document")
F(X,1,"send the pdf you made to maria","share_file","find_customer get_customer_context","follow-up: file already built",
  ["make me a pdf invoice for maria","Done: invoice-maria-gonzalez.pdf, $450 AC repair, balance due $0."])
F(X,0,"open the file i sent earlier and tell me whats in it","read_file","run_command","read sandbox file")
F(X,0,"save these notes as a text file: order filters, call supplier, fix van tire","write_file","","write sandbox file")
F(X,0,"chart of visits per week for the last 2 months","resolve_date query_spine run_command","write_file share_file","plot build")
F(X,0,"make a job sheet for jane for tomorrow","resolve_date get_team_schedule run_command","write_file share_file","stops to printable sheet")
F(X,0,"print ready schedule for next week, send it to jane","resolve_date get_team_schedule run_command share_file","write_file","sent to teammate")
F(X,0,"outstanding balances report pdf","query_spine run_command","resolve_date write_file share_file","report build")
F(X,1,"turn that into excel","run_command","query_spine write_file share_file","follow-up: table already in chat",
  ["payments this month","Payments Monday 2026-09-01 through today: Maria Gonzalez $450 check, Acme Offices $500 ach."])
F(X,1,"add our license number to the invoice header, TACLA12345E","set_firm_profile","query_spine","letterhead lives in firm profile; licenseNumbers replaces whole list")
F(X,1,"invoice pdf has the wrong address on top, its 200 Main St Suite 4","set_firm_profile run_command","","fix profile then regenerate")
F(X,0,"what files do i have in there","run_command","read_file","list sandbox dir")
F(X,0,"read the price list i uploaded and quote acme from it","read_file find_customer get_customer_context","run_command","file + job data")
F(X,1,"email tom his inspection report as a pdf","find_customer get_customer_context list_recent_captures run_command share_file","get_capture send_email write_file","report from notes, file out")
F(X,0,"monthly money summary for sept as xlsx","resolve_date query_spine run_command","write_file share_file","month window")
F(X,0,"merge the two pdfs from earlier into one","run_command","read_file share_file","sandbox op")
F(X,1,"totals wrong, she also had the 75 trip fee","run_command","record_money_event get_job ask_user","follow-up: regenerate; ledger entry only if confirmed",
  ["make me a pdf invoice for maria","Here's invoice-maria-gonzalez.pdf: AC repair $450."])
F(X,0,"csv of every note jane filed this week","resolve_date query_spine run_command","write_file share_file","v_captures by technician_ref")
F(X,0,"give me a pdf of toms service history","find_customer get_customer_context list_recent_captures run_command","query_spine write_file share_file","history doc")
F(X,1,"save acmes gate code 4417 in a file","find_customer record_standing_fact","","belongs on the record as a standing fact, not a file")
F(X,0,"zip up all the invoices and share with my bookkeeper bk@acctco.com","run_command share_file","","sandbox zip then send")
F(X,1,"make it look nicer, bigger logo","run_command","read_file write_file","follow-up: regenerate the invoice",
  ["pdf invoice for tom","Here's invoice-tom-becker.pdf, $280 furnace inspection."])
F(X,0,"our invoices need the texas disclosure","set_firm_profile","","disclosureFooter")

E="email"
F(E,0,"email maria that her warranty paperwork is ready","find_customer get_customer_context send_email","","staged, show then confirm")
F(E,0,"email tom confirming todays visit 9-11","find_customer get_customer_context send_email","get_team_schedule resolve_date","jobId attached")
F(E,1,"send it","send_email","","follow-up: confirmId",
  ["email maria her paperwork is ready","To: maria.g@email.com. Subject: Warranty paperwork ready. Body: Hi Maria, your warranty paperwork is ready... Send it?"])
F(E,1,"change the subject to Your furnace visit then send","send_email","","follow-up: restage with new subject, confirm again",
  ["email tom about today","To: tbecker@email.com. Subject: Visit today. Body: Hi Tom, Jane will be there 9-11... Send it?"])
F(E,0,"email acme the quote for 3200","find_customer get_customer_context send_email","record_money_event","estimate_presented optional")
F(E,0,"email bob@supplyhouse.com asking if they got a 40 gal rheem in stock","send_email","","direct address")
F(E,0,"send maria a reminder she owes 150","find_customer get_customer_context send_email","get_job","balance check")
F(E,1,"text tom we're running late","","find_customer get_customer_context send_email ask_user","no SMS tool: say so, offer email")
F(E,0,"email acme and tell them jane's coming thursday","resolve_date find_customer get_customer_context send_email","get_team_schedule","phrase from resolve_date")
F(E,0,"did we email maria back about the AC","find_customer get_customer_context list_recent_captures","query_spine get_job","sent copies filed on job")
F(E,0,"email tom that we need to reschedule, ask what day works","find_customer get_customer_context send_email","","staged email")
F(E,0,"reply to marias last email saying thanks we'll be there","find_customer get_customer_context list_recent_captures send_email","get_capture get_job","read her email first")
F(E,0,"email orders@ferguson.com: 2 igniters and 1 flame sensor for pickup","send_email","","supplier order")
F(E,1,"dont send that yet, let me think","","","follow-up: no call; staged email simply not confirmed",
  ["email acme the quote","To: office@acme.com. Subject: Quote. Body: ... Send it?"])
F(E,1,"email all customers with open jobs our holiday hours","query_spine send_email","","one staged email per customer")

W="web"
F(W,0,"what does code 33 on a carrier furnace mean","web_search","read_webpage","error code")
F(W,0,"is the supply house on 5th open saturday","web_search","","hours")
F(W,0,"read this for me https://www.energystar.gov/rebate-finder","read_webpage","","given link")
F(W,0,"price on a honeywell t6 thermostat","web_search","","price lookup")
F(W,0,"any rheem water heater recalls this year","web_search","read_webpage","recall")
F(W,1,"open the second one","read_webpage","","follow-up: link from results",
  ["look up lennox igniter part","1. lennox.com parts catalog 2. supplyhouse.com Lennox 100270-03 igniter 3. forum thread"])
F(W,0,"whats the deal with the r-454b rules","web_search","read_webpage","refrigerant regs")
F(W,1,"part number for the igniter on a lennox ml180 and email it to orders@ferguson.com","web_search send_email","read_webpage","search then staged email")
F(W,0,"weather tomorrow for the roof job","web_search","resolve_date get_team_schedule","forecast")
F(W,0,"check this manual https://example.com/ml180-manual.pdf, whats the clearance","read_webpage","","given pdf link")

T="team_admin"
F(T,0,"add a new tech, Carlos Ruiz","add_technician_seat","","two-step, shows minted ref")
F(T,1,"yes","add_technician_seat","","follow-up: confirmId",
  ["add a new tech Carlos Ruiz","This adds Carlos Ruiz as a technician, ref carlos-ruiz, using 1 seat. Confirm?"])
F(T,0,"carlos telegram id is 812345678","bind_telegram","list_team","relay botUsername")
F(T,0,"which bot does jane use","list_team","","botUsername")
F(T,0,"jane quit, remove her","deactivate_technician_seat","list_team","two-step, destroys sandbox")
F(T,0,"janes back, undo that","reactivate_technician_seat","","grace period")
F(T,1,"jane can do boilers now too","list_team set_technician_skills","","replace list: read current first")
F(T,0,"add a helper Mike Ortiz, just for scheduling, no phone stuff","add_technician_seat","","seatExempt:true")
F(T,0,"whos on the team","list_team","","roster")
F(T,1,"we're in dallas","set_timezone","set_firm_profile ask_user","Texas: ask local time, derive zone")
F(T,1,"we moved the shop to denver, 1800 Blake St","set_timezone set_firm_profile","","two changes")
F(T,0,"company name is Sam's Heating & Air LLC, phone 555-0100","set_firm_profile","","profile subset")
F(T,0,"what's on our letterhead right now","set_firm_profile","query_spine","no fields = read")
F(T,1,"add license TX TACL TACLA99887E","set_firm_profile","query_spine","list replaces: include existing ones")
F(T,0,"make a manager seat for my partner Priya Shah","add_technician_seat","","tier manager")
F(T,0,"janes telegram isnt working, her id is 55512312 now","bind_telegram","","re-bind")
F(T,0,"clear janes skills","set_technician_skills","","[] = unknown")
F(T,0,"who left the team this month","resolve_date query_spine","","v_roster_events")
F(T,1,"mike works tue and thu 9-3","set_availability","","follow-up: schedule-only person becomes schedulable",
  ["add mike as a helper","Added Mike Ortiz (schedule-only, no seat). He has no working pattern yet, so the scheduler can't book him."])
F(T,1,"your times look off, its 4:15 here","set_timezone","ask_user","derive zone from stated clock; may ask city")

AC="access"
F(AC,0,"any access requests waiting","list_access","","openRequests")
F(AC,1,"yes give her what she asked","grant_access","list_access","follow-up: requestId + reason",
  ["any requests","Jane asked to see Maria Gonzalez's AC repair job: 'customer asked me about the old repair'."])
F(AC,0,"no to janes request, she doesnt need marias history","list_access decline_access","","reason texted to her")
F(AC,0,"let jane see the acme job","find_customer get_customer_context grant_access","list_team","jobId grant, default 7 days")
F(AC,0,"let jane see the dollar amounts on her jobs","grant_access","list_team","everywhere:true money:true")
F(AC,0,"take away janes access to acme","list_access revoke_access","","grantId")
F(AC,0,"what can jane see","list_access","","rule + grants")
F(AC,0,"let all techs see dollar amounts","set_technician_view","","money amounts")
F(AC,0,"techs should only see their own trips","set_technician_view","","jobScope own_trips")
F(AC,0,"open all of tom beckers history to jane for a month","find_customer grant_access","","customerId, days 30")
F(AC,0,"hide notes tagged pricing from techs","set_technician_view","","hiddenTags")
F(AC,0,"who has access to marias stuff","list_access","query_spine","grants by customer")
F(AC,1,"give her the notes too not just the record, 2 weeks","grant_access","list_access","follow-up: opens record_and_notes, days 14",
  ["any requests","Jane asked to see Tom Becker's furnace inspection: 'need what he told the office'."])
F(AC,0,"reset tech view to default","set_technician_view","","reset all settings")
F(AC,1,"jane keeps asking for everything. cut all her grants","list_access revoke_access","","revoke each grant")

O="office_notes"
F(O,1,"tell the office janes on leave next week","resolve_date add_time_off","inform_team_lead","leave belongs in time off, not only a note")
F(O,0,"let the office know acme wants us to hold off till november","inform_team_lead","find_customer","context the record lacks")
F(O,0,"ask the office if anyone chased marias payment","ask_team_lead","","has this been chased")
F(O,0,"ask jane how the becker visit went","inform_teammate","","teammate's assistant asks")
F(O,0,"tell jane to bring the big ladder tmrw","inform_teammate","","note to teammate")
F(O,0,"is the office waiting on anything from me","ask_team_lead","","office question")
F(O,0,"whats the office working on","ask_team_lead","query_spine","ask")
F(O,0,"i already called tom about the invoice, office doesnt need to","inform_team_lead","","prevent double chase")
F(O,0,"ask jane if she has the flame sensor on the truck","inform_teammate","","teammate question")
F(O,1,"yes he ok'd it on the phone","inform_team_lead","record_money_event","follow-up: answer with replyToMessageId",
  ["anything from the office","Office asks: did Tom approve the extra $350 igniter? (mention m-77)"])
F(O,1,"any messages from the office","ask_team_lead","query_spine","vague; office-sent messages are not in the views")
F(O,0,"remind the office marias warranty claim is still pending with carrier","inform_team_lead","","context note")
F(O,0,"ping jane: great job today","inform_teammate","","teammate note")
F(O,0,"has anyone asked acme about roof access","ask_team_lead","find_customer get_customer_context list_recent_captures","already chased?")
F(O,1,"office should know im out friday, jane runs things","resolve_date inform_team_lead","add_time_off","manager out, context note")

R="record_notes"
F(R,0,"note on becker: filter was filthy, told him to change monthly","record_field_note","find_customer","one call, no ask first")
F(R,0,"acme gate code is 4417","find_customer record_standing_fact","","standing fact, two-step")
F(R,0,"maria prefers email, never call before 10","find_customer record_standing_fact","","both facts one call")
F(R,1,"yes","record_standing_fact","","follow-up: confirmId",
  ["acme gate code 4417","Preview for Acme Offices: gate_code = 4417. Record it?"])
F(R,0,"that filter note went on the wrong customer, pull it","list_recent_captures retract_capture","find_customer get_customer_context record_field_note","retract two-step")
F(R,1,"acme gate code is 4471 not 4417","find_customer record_standing_fact","","re-record the key, not retract")
F(R,0,"toms got a big dog, heads up for techs","find_customer record_standing_fact","record_field_note","durable fact")
F(R,0,"log that i talked to maria, shes happy with the AC","record_field_note","find_customer","note")
F(R,0,"jane says the becker heat exchanger is cracked","record_field_note","inform_team_lead","note on record")
F(R,1,"no it was a phone call, not a trip","inform_team_lead","","follow-up: assumed trip, pass the situation to the office",
  ["note maria happy with the AC","Recorded. It went on a new trip for Maria since none was booked for you."])
F(R,1,"the note i just sent was wrong, it was acme not tom","record_field_note retract_capture","list_recent_captures","record correction first, then retract")
F(R,0,"record: acme parking is in the back lot, use the loading dock door","find_customer record_standing_fact","","standing facts")
F(R,1,"tom becker","record_field_note","find_customer","follow-up: needs_identity answer with confirmId",
  ["note: replaced igniter, all good","Which customer was that for?"])
F(R,0,"show me retracted notes on the becker job","find_customer get_customer_context list_recent_captures","get_capture","includeRetracted")
F(R,1,"new walk in, Ana Ortiz 88 Pine St, wants a tankless quote","find_customer record_field_note","open_job","note creates the customer after confirm")

F(B,1,"book tom tmrw 9-11 with jane and email him to confirm","resolve_date find_customer book_visit send_email","get_customer_context","two requests: book then staged email")
F(M,1,"maria paid 450 by check, send her a receipt pdf","find_customer get_customer_context record_money_event run_command share_file","write_file set_firm_profile","ledger then document out")
F(R,1,"tom says call his cell not the house, 555-0177, and the furnace job will need a 2nd trip","find_customer record_standing_fact","get_customer_context record_field_note book_visit ask_user","standing fact; second trip needs a day/time before booking")
F(S,1,"whats tomorrow look like and is jane off any day next week","resolve_date get_team_schedule get_availability","","two reads: schedule + time off")
F(AC,1,"let jane see acme and tell her to get there by thursday","find_customer get_customer_context grant_access inform_teammate","resolve_date list_team","grant, then note to her assistant")

Z="small_talk"
for t,n in [("thanks!","ack"),("ok cool","ack"),("lol","ack"),("good morning","greeting"),("ur a lifesaver","ack"),
            ("never mind","drop it"),("what can you do?","capability answer"),("brb","ack"),("haha yeah","ack"),
            ("how do i hook up my email to this","no tool; email setup moves to settings UI")]:
    F(Z,0,t,"","",n)

with open(OUT,"w") as f:
    for i,r in enumerate(rows,1):
        r = {"id": f"s{i:03d}", **r}
        r["hard"] = bool(r["hard"])
        f.write(json.dumps(r, ensure_ascii=False)+"\n")
print(len(rows))
