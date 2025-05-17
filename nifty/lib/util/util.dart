class Util {
  static const String baseUrl = "http://localhost:3000";

  static DateTime convertStringtoDateTime(String datetime) {
    return DateTime.parse(datetime);
  }

  static getChange(num from, num to) {
    num n = to - from;
    return n.toStringAsFixed(0);
  }

  static num asnum(dynamic number) {
    num result = 0;
    if (number != null) {
      if (number is String) {
        result = num.parse(number);
      } else {
        result = number;
      }
    }
    return result;
  }

  static convertNumToString(num number) {
    return number.toStringAsFixed(0);
  }
}
