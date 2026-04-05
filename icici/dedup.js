db.NiftyQuote.aggregate([
  { $group: { _id: { ltt: "$ltt", ltp: "$ltp" }, ids: { $push: "$_id" }, count: { $sum: 1 } } },
  { $match: { count: { $gt: 1 } } }
]).forEach(group => {
  group.ids.shift();
  db.NiftyQuote.deleteMany({ _id: { $in: group.ids } });
});
