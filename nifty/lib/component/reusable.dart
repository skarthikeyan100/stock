import 'package:flutter/material.dart';

class Reusable {
  static final radius5 =
      RoundedRectangleBorder(borderRadius: BorderRadius.circular(5.0));

  static getTime(DateTime dateTime) {
    return '${dateTime.hour}:${dateTime.minute}';
  }

  static getDiff(num from, num to) {
    return from - to;
  }

}
